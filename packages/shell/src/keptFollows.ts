export type KeptFollows = { kept: number; used: number; dropped: number };

export type KeptFollowsNative = { takeKeptFollows(): KeptFollows };
