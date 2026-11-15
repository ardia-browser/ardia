// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/owner_check_core.h"

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/run_loop.h"
#include "base/test/bind.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

std::vector<uint8_t> Bytes(std::string_view text) {
  return std::vector<uint8_t>(text.begin(), text.end());
}

SecretBytes Secret(std::string_view text) {
  return SecretBytes(base::as_byte_span(text));
}

struct Refusal {
  std::string message;
  base::TimeDelta retry;
};

struct PromptLog {
  int asked = 0;
  int unavailable = 0;
  int focused = 0;
  int closed = 0;
  base::TimeDelta first_retry;
  std::vector<Refusal> refusals;
  OwnerPrompt::Answered pending;
};

class FakePrompt : public OwnerPrompt {
 public:
  explicit FakePrompt(PromptLog* log) : log_(log) {}
  ~FakePrompt() override {
    ++log_->closed;
    if (log_->pending) {
      std::move(log_->pending).Run(std::nullopt);
    }
  }
  void NextAnswer(Answered answered) override {
    log_->pending = std::move(answered);
  }
  void Refuse(const std::string& message, base::TimeDelta retry) override {
    log_->refusals.push_back({message, retry});
  }
  void Focus() override { ++log_->focused; }

 private:
  raw_ptr<PromptLog> log_;
};

class FakeUi : public OwnerPromptUi {
 public:
  explicit FakeUi(PromptLog* log) : log_(log) {}
  std::unique_ptr<OwnerPrompt> Ask(const std::string&,
                                   base::TimeDelta retry) override {
    ++log_->asked;
    log_->first_retry = retry;
    return std::make_unique<FakePrompt>(log_);
  }
  void TellUnavailable(const std::string&,
                       base::OnceClosure dismissed) override {
    ++log_->unavailable;
    std::move(dismissed).Run();
  }

 private:
  raw_ptr<PromptLog> log_;
};

class OwnerCheckTest : public testing::Test {
 protected:
  void Make(std::optional<base::FilePath> helper = base::FilePath("/helper"),
            std::optional<std::string> test_answer = std::nullopt) {
    OwnerCheck::Delegate delegate;
    delegate.find_helper = base::BindRepeating(
        [](std::optional<base::FilePath> helper,
           OwnerCheck::HelperFound found) { std::move(found).Run(helper); },
        helper);
    delegate.check_password = base::BindRepeating(
        &OwnerCheckTest::CheckPassword, base::Unretained(this));
    delegate.count = base::BindRepeating(
        [](std::map<std::string, int>* counts, std::string_view name) {
          ++(*counts)[std::string(name)];
        },
        &counts_);
    delegate.test_answer = std::move(test_answer);
    delegate.now = base::BindRepeating(
        [](const base::TickClock* clock) { return clock->NowTicks(); },
        task_environment_.GetMockTickClock());
    check_ = std::make_unique<OwnerCheck>(std::move(delegate),
                                          std::make_unique<FakeUi>(&log_));
  }

  void CheckPassword(const base::FilePath&,
                     SecretBytes password,
                     base::OnceCallback<void(HelperVerdict)> checked) {
    std::string typed(password.bytes().begin(), password.bytes().end());
    checked_.push_back(typed);
    if (hold_checks_) {
      held_ = base::BindOnce(std::move(checked), typed == "right"
                                                     ? HelperVerdict::kMatch
                                                     : HelperVerdict::kMismatch);
      return;
    }
    std::move(checked).Run(typed == "right"   ? HelperVerdict::kMatch
                           : typed == "crash" ? HelperVerdict::kFailed
                                              : HelperVerdict::kMismatch);
  }

  void Type(std::string_view text) {
    ASSERT_TRUE(log_.pending);
    std::move(log_.pending).Run(Secret(text));
  }

  void Cancel() {
    ASSERT_TRUE(log_.pending);
    std::move(log_.pending).Run(std::nullopt);
  }

  base::test::SingleThreadTaskEnvironment task_environment_{
      base::test::TaskEnvironment::TimeSource::MOCK_TIME};
  PromptLog log_;
  std::map<std::string, int> counts_;
  std::vector<std::string> checked_;
  bool hold_checks_ = false;
  base::OnceClosure held_;
  std::unique_ptr<OwnerCheck> check_;
};

TEST_F(OwnerCheckTest, RightPasswordGrantsAfterAWrongOneIsRefused) {
  Make();
  base::test::TestFuture<bool> granted;
  check_->Confirm("show your saved passwords", granted.GetCallback());
  Type("wrong");
  ASSERT_EQ(log_.refusals.size(), 1u);
  EXPECT_EQ(log_.refusals[0].message, "Wrong password.");
  Type("right");
  EXPECT_TRUE(granted.Get());
  EXPECT_EQ(log_.closed, 1);
  EXPECT_EQ(counts_["owner_check_asked"], 1);
  EXPECT_EQ(counts_["owner_check_granted"], 1);
  EXPECT_EQ(counts_["owner_check_wrong_passwords"], 1);
}

TEST_F(OwnerCheckTest, AGrantCountsForAMinuteWithoutAskingAgain) {
  Make();
  base::test::TestFuture<bool> first;
  check_->Confirm("x", first.GetCallback());
  Type("right");
  ASSERT_TRUE(first.Get());
  base::test::TestFuture<bool> second;
  check_->Confirm("x", second.GetCallback());
  EXPECT_TRUE(second.Get());
  EXPECT_EQ(log_.asked, 1);
  task_environment_.FastForwardBy(base::Seconds(61));
  base::test::TestFuture<bool> third;
  check_->Confirm("x", third.GetCallback());
  EXPECT_EQ(log_.asked, 2);
  Cancel();
  EXPECT_FALSE(third.Get());
}

TEST_F(OwnerCheckTest, CancellingDenies) {
  Make();
  base::test::TestFuture<bool> granted;
  check_->Confirm("x", granted.GetCallback());
  Cancel();
  EXPECT_FALSE(granted.Get());
  EXPECT_EQ(counts_["owner_check_cancelled"], 1);
}

TEST_F(OwnerCheckTest, OnePromptAtATimeAndASecondAskFocusesIt) {
  Make();
  base::test::TestFuture<bool> first;
  base::test::TestFuture<bool> second;
  check_->Confirm("x", first.GetCallback());
  check_->Confirm("x", second.GetCallback());
  EXPECT_EQ(log_.asked, 1);
  EXPECT_EQ(log_.focused, 1);
  Type("right");
  EXPECT_TRUE(first.Get());
  EXPECT_TRUE(second.Get());
}

TEST_F(OwnerCheckTest, NoHelperDeniesAndSaysWhyWithoutAsking) {
  Make(std::nullopt);
  base::test::TestFuture<bool> granted;
  check_->Confirm("x", granted.GetCallback());
  EXPECT_FALSE(granted.Get());
  EXPECT_EQ(log_.asked, 0);
  EXPECT_EQ(log_.unavailable, 1);
  EXPECT_EQ(counts_["owner_check_unavailable"], 1);
}

TEST_F(OwnerCheckTest, TestAnswersSkipThePrompt) {
  Make(base::FilePath("/helper"), "");
  base::test::TestFuture<bool> granted;
  check_->Confirm("x", granted.GetCallback());
  EXPECT_TRUE(granted.Get());
  check_->RevokeGrant();
  Make(base::FilePath("/helper"), "denied");
  base::test::TestFuture<bool> denied;
  check_->Confirm("x", denied.GetCallback());
  EXPECT_FALSE(denied.Get());
  EXPECT_EQ(log_.asked, 0);
}

TEST_F(OwnerCheckTest, WrongPasswordsWaitLongerAcrossPrompts) {
  Make();
  base::test::TestFuture<bool> granted;
  check_->Confirm("x", granted.GetCallback());
  Type("a");
  Type("b");
  EXPECT_EQ(log_.refusals.back().retry, base::TimeDelta());
  Type("c");
  EXPECT_EQ(log_.refusals.back().retry, base::Seconds(2));
  Type("d");
  EXPECT_EQ(log_.refusals.back().message, "");
  EXPECT_EQ(checked_.size(), 3u);
  EXPECT_EQ(counts_["owner_check_throttled"], 1);
  Cancel();
  EXPECT_FALSE(granted.Get());
  base::test::TestFuture<bool> again;
  check_->Confirm("x", again.GetCallback());
  EXPECT_EQ(log_.first_retry, base::Seconds(2));
  task_environment_.FastForwardBy(base::Seconds(2));
  Type("e");
  EXPECT_EQ(log_.refusals.back().retry, base::Seconds(5));
  task_environment_.FastForwardBy(base::Seconds(5));
  Type("f");
  EXPECT_EQ(log_.refusals.back().retry, base::Seconds(30));
  task_environment_.FastForwardBy(base::Seconds(30));
  Type("g");
  EXPECT_EQ(log_.refusals.back().retry, base::Seconds(60));
  task_environment_.FastForwardBy(base::Seconds(60));
  Type("h");
  EXPECT_EQ(log_.refusals.back().retry, base::Seconds(60));
  task_environment_.FastForwardBy(base::Seconds(60));
  Type("right");
  EXPECT_TRUE(again.Get());
  EXPECT_EQ(check_->throttle().wrong_passwords(), 0);
}

TEST_F(OwnerCheckTest, AHelperFailureIsNotAWrongPassword) {
  Make();
  base::test::TestFuture<bool> granted;
  check_->Confirm("x", granted.GetCallback());
  Type("crash");
  EXPECT_EQ(log_.refusals.back().message,
            "Ardia couldn't check the password.");
  EXPECT_EQ(check_->throttle().wrong_passwords(), 0);
  EXPECT_EQ(counts_["owner_check_helper_failures"], 1);
  Cancel();
  EXPECT_FALSE(granted.Get());
}

TEST_F(OwnerCheckTest, UnusablePasswordsNeverReachTheHelper) {
  Make();
  base::test::TestFuture<bool> granted;
  check_->Confirm("x", granted.GetCallback());
  Type(std::string(513, 'a'));
  EXPECT_EQ(log_.refusals.back().message,
            "That password is too long to check.");
  Type(std::string("a\0b", 3));
  EXPECT_EQ(log_.refusals.back().message, "That password can't be checked.");
  EXPECT_TRUE(checked_.empty());
  Cancel();
  EXPECT_FALSE(granted.Get());
}

TEST_F(OwnerCheckTest, GoingAwayClosesThePromptAndDenies) {
  Make();
  base::test::TestFuture<bool> granted;
  check_->Confirm("x", granted.GetCallback());
  int away = 0;
  check_->AddAwayListener(base::BindLambdaForTesting([&] { ++away; }));
  const int presence = check_->presence();
  check_->OwnerWentAway();
  EXPECT_FALSE(granted.Get());
  EXPECT_EQ(log_.closed, 1);
  EXPECT_EQ(away, 1);
  EXPECT_FALSE(check_->StillPresent(presence));
}

TEST_F(OwnerCheckTest, ARightPasswordCheckedAfterGoingAwayGrantsNothing) {
  Make();
  hold_checks_ = true;
  base::test::TestFuture<bool> granted;
  check_->Confirm("x", granted.GetCallback());
  Type("right");
  ASSERT_TRUE(held_);
  check_->OwnerWentAway();
  std::move(held_).Run();
  EXPECT_FALSE(granted.Get());
  hold_checks_ = false;
  base::test::TestFuture<bool> next;
  check_->Confirm("x", next.GetCallback());
  EXPECT_EQ(log_.asked, 2);
  Cancel();
  EXPECT_FALSE(next.Get());
}

TEST_F(OwnerCheckTest, GoingAwayDropsAGrant) {
  Make();
  base::test::TestFuture<bool> granted;
  check_->Confirm("x", granted.GetCallback());
  Type("right");
  ASSERT_TRUE(granted.Get());
  check_->OwnerWentAway();
  base::test::TestFuture<bool> next;
  check_->Confirm("x", next.GetCallback());
  EXPECT_EQ(log_.asked, 2);
  Cancel();
  EXPECT_FALSE(next.Get());
}

std::optional<HelperFileFacts> Facts(bool directory, uid_t owner, mode_t mode) {
  HelperFileFacts facts;
  facts.regular = !directory;
  facts.directory = directory;
  facts.owner = owner;
  facts.mode = mode;
  return facts;
}

TEST(TrustedPasswordHelperTest, OnlyRootOwnedHelpersInRootOwnedFoldersNobodyElseCanWrite) {
  base::ScopedTempDir scratch;
  ASSERT_TRUE(scratch.CreateUniqueTempDir());
  base::FilePath real = base::MakeAbsoluteFilePath(scratch.GetPath());
  base::FilePath helper = real.Append("unix_chkpwd");
  ASSERT_TRUE(base::WriteFile(helper, "x"));
  base::FilePath link = real.Append("link");
  ASSERT_TRUE(base::CreateSymbolicLink(helper, link));

  std::map<base::FilePath, std::optional<HelperFileFacts>> facts;
  auto stat = base::BindLambdaForTesting(
      [&](const base::FilePath& path) -> std::optional<HelperFileFacts> {
        auto found = facts.find(path);
        return found == facts.end() ? Facts(true, 0, 040755) : found->second;
      });

  facts[helper] = Facts(false, 0, 0102755);
  EXPECT_EQ(TrustedPasswordHelper(helper, base::BindRepeating(stat)), helper);
  EXPECT_EQ(TrustedPasswordHelper(link, base::BindRepeating(stat)), helper);

  facts[helper] = Facts(false, 1000, 0100755);
  EXPECT_FALSE(TrustedPasswordHelper(helper, base::BindRepeating(stat)));
  facts[helper] = Facts(false, 0, 0100775);
  EXPECT_FALSE(TrustedPasswordHelper(helper, base::BindRepeating(stat)));
  facts[helper] = Facts(false, 0, 0100757);
  EXPECT_FALSE(TrustedPasswordHelper(helper, base::BindRepeating(stat)));
  facts[helper] = Facts(false, 0, 0100644);
  EXPECT_FALSE(TrustedPasswordHelper(helper, base::BindRepeating(stat)));

  facts[helper] = Facts(false, 0, 0100755);
  facts[real.DirName()] = Facts(true, 0, 040775);
  EXPECT_FALSE(TrustedPasswordHelper(helper, base::BindRepeating(stat)));
  facts[real.DirName()] = Facts(true, 1000, 040755);
  EXPECT_FALSE(TrustedPasswordHelper(helper, base::BindRepeating(stat)));
  facts[real.DirName()] = std::nullopt;
  EXPECT_FALSE(TrustedPasswordHelper(helper, base::BindRepeating(stat)));
  facts.erase(real.DirName());
  EXPECT_FALSE(TrustedPasswordHelper(real.Append("missing"),
                                     base::BindRepeating(stat)));
}

TEST(TrustedPasswordHelperTest, TheSystemHelperIsTrustedWhereItExists) {
  base::FilePath system("/usr/sbin/unix_chkpwd");
  if (!base::PathExists(system)) {
    GTEST_SKIP();
  }
  EXPECT_TRUE(
      TrustedPasswordHelper(system, base::BindRepeating(&StatHelperFileOnDisk)));
}

class PasswordHelperTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(scratch_.CreateUniqueTempDir());
    heard_ = scratch_.GetPath().Append("heard");
    helper_ = scratch_.GetPath().Append("helper");
  }

  void Script(std::string_view body) {
    ASSERT_TRUE(base::WriteFile(
        helper_, "#!/bin/bash\n" + std::string(body) + "\n"));
    ASSERT_TRUE(base::SetPosixFilePermissions(helper_, 0700));
  }

  base::test::TaskEnvironment task_environment_;
  base::ScopedTempDir scratch_;
  base::FilePath heard_;
  base::FilePath helper_;
};

TEST_F(PasswordHelperTest, ReadsThePasswordNulTerminatedWithTheUserAndNonull) {
  Script("echo -n \"$1 $2 \" > " + heard_.value() + "; cat >> " +
         heard_.value() + "; exit 0");
  EXPECT_EQ(RunPasswordHelper(helper_, "owner", Secret("pa ss")),
            HelperVerdict::kMatch);
  std::string heard;
  ASSERT_TRUE(base::ReadFileToString(heard_, &heard));
  EXPECT_EQ(heard, std::string("owner nonull pa ss\0", 19));
}

TEST_F(PasswordHelperTest, ExitSevenIsAWrongPasswordAndAnythingElseAFailure) {
  Script("cat > /dev/null; exit 7");
  EXPECT_EQ(RunPasswordHelper(helper_, "owner", Secret("x")),
            HelperVerdict::kMismatch);
  Script("cat > /dev/null; exit 1");
  EXPECT_EQ(RunPasswordHelper(helper_, "owner", Secret("x")),
            HelperVerdict::kFailed);
  Script("kill -SEGV $$");
  EXPECT_EQ(RunPasswordHelper(helper_, "owner", Secret("x")),
            HelperVerdict::kFailed);
  EXPECT_EQ(RunPasswordHelper(scratch_.GetPath().Append("missing"), "owner",
                              Secret("x")),
            HelperVerdict::kFailed);
}

TEST_F(PasswordHelperTest, TheHelperMayGainItsSetgidGroup) {
  Script(
      "cat > /dev/null; "
      "grep -q '^NoNewPrivs:[[:space:]]*0$' /proc/self/status");
  EXPECT_EQ(RunPasswordHelper(helper_, "owner", Secret("x")),
            HelperVerdict::kMatch);
}

TEST_F(PasswordHelperTest, AHelperThatHangsPastItsDeadlineFails) {
  Script("exec sleep 30");
  base::TimeTicks start = base::TimeTicks::Now();
  EXPECT_EQ(RunPasswordHelper(helper_, "owner", Secret("x"),
                              base::Milliseconds(300)),
            HelperVerdict::kFailed);
  EXPECT_LT(base::TimeTicks::Now() - start, base::Seconds(5));
}

TEST(SecretBytesTest, WipesWhatItHeldWhenMovedOrDestroyed) {
  SecretBytes secret = Secret("hunter2");
  SecretBytes moved = std::move(secret);
  EXPECT_TRUE(secret.empty());
  EXPECT_EQ(moved.size(), 7u);
  moved.Wipe();
  EXPECT_TRUE(moved.empty());
  std::vector<uint8_t> bytes = Bytes("abc");
  WipeBytes(bytes);
  EXPECT_EQ(bytes, std::vector<uint8_t>(3, 0));
  EXPECT_EQ(SecretBytes::FromUtf16(u"é").size(), 2u);
}

TEST(OwnerCheckRulesTest, VerdictsAndUnusablePasswords) {
  EXPECT_EQ(VerdictForExit(0), HelperVerdict::kMatch);
  EXPECT_EQ(VerdictForExit(7), HelperVerdict::kMismatch);
  EXPECT_EQ(VerdictForExit(1), HelperVerdict::kFailed);
  EXPECT_EQ(VerdictForExit(std::nullopt), HelperVerdict::kFailed);
  EXPECT_FALSE(UnusablePassword(Bytes(std::string(512, 'a'))));
  EXPECT_TRUE(UnusablePassword(Bytes(std::string(513, 'a'))));
}

}

}
