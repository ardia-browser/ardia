package com.ardia.phone

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal class CaptureSlot<T>(private val scope: CoroutineScope) {
    private class Request<T>(val generation: Long, val job: Deferred<T>)

    private var newest: Request<T>? = null
    private var tail: Job? = null
    private var generations = 0L

    val waiting: Boolean get() = newest != null

    fun start(work: suspend () -> T): Deferred<T> {
        newest?.job?.cancel()
        val generation = ++generations
        val before = tail
        val job = scope.async(start = CoroutineStart.ATOMIC) {
            withContext(NonCancellable) { before?.join() }
            ensureActive()
            if (newest?.generation != generation) throw ReplacedCapture()
            work()
        }
        newest = Request(generation, job)
        tail = job
        job.invokeOnCompletion {
            scope.launch {
                if (newest?.generation == generation) newest = null
                if (tail === job) tail = null
            }
        }
        return job
    }

    fun cancel(): Job? {
        val job = newest?.job ?: return tail
        job.cancel()
        return job
    }
}

internal class ReplacedCapture : IllegalStateException("A newer capture replaced this one")
