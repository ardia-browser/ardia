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
    private class Request<T>(val generation: Long, val job: Deferred<T>) {
        var settled: Job? = null
    }

    private var newest: Request<T>? = null
    private var tail: Job? = null
    private var generations = 0L

    val waiting: Boolean get() = newest != null

    fun start(work: suspend () -> T): Deferred<T> {
        newest?.job?.cancel()
        val generation = ++generations
        val before = tail
        val job = scope.async(start = CoroutineStart.LAZY) {
            withContext(NonCancellable) { before?.join() }
            ensureActive()
            if (newest?.generation != generation) throw ReplacedCapture()
            work()
        }
        val request = Request(generation, job)
        newest = request
        val settled = scope.launch(NonCancellable) {
            before?.join()
            job.join()
        }
        request.settled = settled
        tail = settled
        job.invokeOnCompletion { scope.launch { if (newest === request) newest = null } }
        settled.invokeOnCompletion { scope.launch { if (tail === settled) tail = null } }
        job.start()
        return job
    }

    fun cancel(): Job? {
        val request = newest ?: return tail
        request.job.cancel()
        return request.settled ?: request.job
    }
}

internal class ReplacedCapture : IllegalStateException("A newer capture replaced this one")
