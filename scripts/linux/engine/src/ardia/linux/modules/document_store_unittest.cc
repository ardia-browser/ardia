// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/document_store.h"

#include <optional>
#include <string>

#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/run_loop.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/thread_pool.h"
#include "base/test/task_environment.h"
#include "base/test/test_future.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

class DocumentStoreTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(folder_.CreateUniqueTempDir());
    disk_ = base::ThreadPool::CreateSequencedTaskRunner(
        {base::MayBlock(), base::TaskShutdownBehavior::BLOCK_SHUTDOWN});
  }

  std::unique_ptr<DocumentStore> LoadedStore() {
    auto store = std::make_unique<DocumentStore>(folder_.GetPath(), disk_);
    base::RunLoop loaded;
    store->Load(loaded.QuitClosure());
    loaded.Run();
    return store;
  }

  std::string OnDisk(const std::string& name) {
    std::string contents;
    if (!base::ReadFileToString(folder_.GetPath().Append(name), &contents)) {
      return "<missing>";
    }
    return contents;
  }

  void Drain() { task_environment_.RunUntilIdle(); }

  base::test::TaskEnvironment task_environment_{
      base::test::TaskEnvironment::TimeSource::MOCK_TIME};
  base::ScopedTempDir folder_;
  scoped_refptr<base::SequencedTaskRunner> disk_;
};

TEST_F(DocumentStoreTest, NamesAreConfinedToTheFolder) {
  EXPECT_EQ(DocumentStore::KeyOf("Session.json"), "Session.json");
  EXPECT_EQ(DocumentStore::KeyOf("nested/folder/leaf"), "leaf");
  EXPECT_EQ(DocumentStore::KeyOf("..\\..\\evil"), "evil");
  EXPECT_EQ(DocumentStore::KeyOf("../"), std::nullopt);
  EXPECT_EQ(DocumentStore::KeyOf(".."), std::nullopt);
  EXPECT_EQ(DocumentStore::KeyOf(""), std::nullopt);
  EXPECT_EQ(DocumentStore::KeyOf(std::string("a\nb")), std::nullopt);
}

TEST_F(DocumentStoreTest, LoadsWhatIsOnDiskAndReadsFromMemory) {
  ASSERT_TRUE(base::WriteFile(folder_.GetPath().Append("State.json"), "{}"));
  ASSERT_TRUE(base::WriteFile(folder_.GetPath().Append("Bad.txt"),
                              std::string("caf\xc3", 4)));
  ASSERT_TRUE(base::CreateDirectory(folder_.GetPath().Append("Chromium")));
  auto store = LoadedStore();
  EXPECT_EQ(store->Read("State.json").value(), "{}");
  EXPECT_EQ(store->Read("Bad.txt").value(), "caf\xef\xbf\xbd");
  EXPECT_EQ(store->Read("Chromium").value(), std::nullopt);
  EXPECT_EQ(store->Read("Missing.json").value(), std::nullopt);
  ASSERT_TRUE(base::DeleteFile(folder_.GetPath().Append("State.json")));
  EXPECT_EQ(store->Read("State.json").value(), "{}");
}

TEST_F(DocumentStoreTest, AReadBeforeTheLoadIsAnErrorNotAnEmptyDocument) {
  ASSERT_TRUE(base::WriteFile(folder_.GetPath().Append("State.json"), "{}"));
  DocumentStore store(folder_.GetPath(), disk_);
  EXPECT_FALSE(store.Read("State.json").has_value());
  store.Write("Other.json", "1");
  EXPECT_EQ(store.Read("Other.json").value(), "1");
  base::RunLoop loaded;
  store.Load(loaded.QuitClosure());
  loaded.Run();
  EXPECT_EQ(store.Read("State.json").value(), "{}");
}

TEST_F(DocumentStoreTest, WritesLandAtomicallyNewestWins) {
  auto store = LoadedStore();
  for (int i = 0; i < 20; ++i) {
    EXPECT_TRUE(store->Write("Session.json", base::NumberToString(i)));
  }
  EXPECT_EQ(store->Read("Session.json").value(), "19");
  base::test::TestFuture<std::optional<std::string>> saved;
  store->WhenSaved("Session.json", saved.GetCallback());
  EXPECT_EQ(saved.Get(), std::nullopt);
  EXPECT_EQ(OnDisk("Session.json"), "19");
  EXPECT_EQ(store->staged_count(), 0u);
  base::FileEnumerator leftovers(folder_.GetPath(), false,
                                 base::FileEnumerator::FILES);
  int files = 0;
  for (base::FilePath path = leftovers.Next(); !path.empty();
       path = leftovers.Next()) {
    ++files;
  }
  EXPECT_EQ(files, 1);
}

TEST_F(DocumentStoreTest, SaveDocumentSettlesAfterTheFileIsOnDisk) {
  auto store = LoadedStore();
  base::test::TestFuture<std::optional<std::string>> saved;
  EXPECT_TRUE(store->Write("Prefs.json", "{\"a\":1}", saved.GetCallback()));
  EXPECT_EQ(saved.Get(), std::nullopt);
  EXPECT_EQ(OnDisk("Prefs.json"), "{\"a\":1}");
}

TEST_F(DocumentStoreTest, RemoveWinsOverAnEarlierWriteAndLosesToALaterOne) {
  auto store = LoadedStore();
  store->Write("A.json", "first");
  EXPECT_TRUE(store->Remove("A.json"));
  EXPECT_EQ(store->Read("A.json").value(), std::nullopt);
  Drain();
  EXPECT_EQ(OnDisk("A.json"), "<missing>");
  store->Remove("B.json");
  store->Write("B.json", "kept");
  Drain();
  EXPECT_EQ(OnDisk("B.json"), "kept");
}

TEST_F(DocumentStoreTest, AFailedWriteRejectsItsWaitersAndRetries) {
  const base::FilePath blocked = folder_.GetPath().Append("Blocked.json");
  ASSERT_TRUE(base::CreateDirectory(blocked.Append("inside")));
  auto store = LoadedStore();
  store->set_retry_base_for_testing(base::Milliseconds(10));
  base::test::TestFuture<std::optional<std::string>> saved;
  store->Write("Blocked.json", "x", saved.GetCallback());
  EXPECT_TRUE(saved.Get().has_value());
  EXPECT_EQ(store->staged_count(), 1u);
  ASSERT_TRUE(base::DeletePathRecursively(blocked));
  task_environment_.FastForwardBy(base::Seconds(1));
  Drain();
  EXPECT_EQ(OnDisk("Blocked.json"), "x");
  EXPECT_EQ(store->staged_count(), 0u);
}

TEST_F(DocumentStoreTest, FlushLandsEverythingStagedAndClosesTheStore) {
  const base::FilePath blocked = folder_.GetPath().Append("Late.json");
  ASSERT_TRUE(base::CreateDirectory(blocked.Append("inside")));
  auto store = LoadedStore();
  store->set_retry_base_for_testing(base::Hours(1));
  store->Write("Late.json", "late");
  Drain();
  EXPECT_EQ(store->staged_count(), 1u);
  ASSERT_TRUE(base::DeletePathRecursively(blocked));
  store->Write("Session.json", "s");
  store->Flush();
  EXPECT_FALSE(store->Write("After.json", "no"));
  EXPECT_FALSE(store->Remove("Session.json"));
  Drain();
  EXPECT_EQ(OnDisk("Late.json"), "late");
  EXPECT_EQ(OnDisk("Session.json"), "s");
  EXPECT_EQ(OnDisk("After.json"), "<missing>");
}

TEST_F(DocumentStoreTest, WrittenFilesAreOwnerOnly) {
  auto store = LoadedStore();
  store->Write("Secret.json", "s");
  Drain();
  int mode = 0;
  ASSERT_TRUE(base::GetPosixFilePermissions(
      folder_.GetPath().Append("Secret.json"), &mode));
  EXPECT_EQ(mode & 0077, 0);
}

}

}
