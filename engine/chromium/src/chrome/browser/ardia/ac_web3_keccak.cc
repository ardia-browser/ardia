// Copyright 2026 Ardia. Apache-2.0.

#include <array>
#include <cstring>

#include "chrome/browser/ardia/ac_web3_codec.h"

namespace ardia::web3 {
namespace {

constexpr size_t kRate = 136;
constexpr size_t kHashSize = 32;

constexpr uint64_t kRoundConstants[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
    0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
    0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
    0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL};
constexpr int kRotations[24] = {1,  3,  6,  10, 15, 21, 28, 36,
                                45, 55, 2,  14, 27, 41, 56, 8,
                                25, 43, 62, 18, 39, 61, 20, 44};
constexpr int kLanes[24] = {10, 7,  11, 17, 18, 3, 5,  16, 8,  21, 24, 4,
                            15, 23, 19, 13, 12, 2, 20, 14, 22, 9,  6,  1};

uint64_t RotateLeft(uint64_t value, int bits) {
  return (value << bits) | (value >> (64 - bits));
}

void KeccakPermute(std::array<uint64_t, 25>& state) {
  for (uint64_t round_constant : kRoundConstants) {
    uint64_t columns[5];
    for (int i = 0; i < 5; ++i) {
      columns[i] = state[i] ^ state[i + 5] ^ state[i + 10] ^ state[i + 15] ^
                   state[i + 20];
    }
    for (int i = 0; i < 5; ++i) {
      const uint64_t mix =
          columns[(i + 4) % 5] ^ RotateLeft(columns[(i + 1) % 5], 1);
      for (int j = 0; j < 25; j += 5) {
        state[j + i] ^= mix;
      }
    }
    uint64_t carried = state[1];
    for (int i = 0; i < 24; ++i) {
      const uint64_t next = state[kLanes[i]];
      state[kLanes[i]] = RotateLeft(carried, kRotations[i]);
      carried = next;
    }
    for (int j = 0; j < 25; j += 5) {
      uint64_t row[5];
      for (int i = 0; i < 5; ++i) {
        row[i] = state[j + i];
      }
      for (int i = 0; i < 5; ++i) {
        state[j + i] ^= ~row[(i + 1) % 5] & row[(i + 2) % 5];
      }
    }
    state[0] ^= round_constant;
  }
}

void Absorb(std::array<uint64_t, 25>& state, const unsigned char* block) {
  for (size_t i = 0; i < kRate / 8; ++i) {
    uint64_t lane = 0;
    for (int b = 7; b >= 0; --b) {
      lane = (lane << 8) | block[i * 8 + b];
    }
    state[i] ^= lane;
  }
  KeccakPermute(state);
}

}

Bytes Keccak256(std::string_view data) {
  std::array<uint64_t, 25> state{};
  const unsigned char* bytes = reinterpret_cast<const unsigned char*>(data.data());
  size_t size = data.size();
  while (size >= kRate) {
    Absorb(state, bytes);
    bytes += kRate;
    size -= kRate;
  }
  unsigned char last[kRate] = {};
  std::memcpy(last, bytes, size);
  last[size] ^= 0x01;
  last[kRate - 1] ^= 0x80;
  Absorb(state, last);
  Bytes out(kHashSize, '\0');
  for (size_t i = 0; i < kHashSize; ++i) {
    out[i] = static_cast<char>((state[i / 8] >> (8 * (i % 8))) & 0xff);
  }
  return out;
}

}
