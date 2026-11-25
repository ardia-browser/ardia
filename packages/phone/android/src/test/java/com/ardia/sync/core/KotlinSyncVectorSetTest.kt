package com.ardia.sync.core

import java.io.File
import org.junit.Assume.assumeTrue
import org.junit.Test

class KotlinSyncVectorSetTest {
    @Test
    fun writeTheKotlinSet() {
        val target = System.getenv("ARDIA_SYNC_VECTORS_WRITE").orEmpty()
        assumeTrue("set ARDIA_SYNC_VECTORS_WRITE to a sync-vectors folder to rewrite its kotlin/ set", target.isNotEmpty())
        SyncVectors.writeRandomSet(SyncVectors.inputs, "kotlin", File(target, "kotlin"))
    }
}
