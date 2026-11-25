package com.ardia.phone

import com.ardia.chatgpt.LoopbackRequest
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import kotlinx.coroutines.CompletableDeferred

internal class LoopbackCallbackServer private constructor(private val socket: ServerSocket) {
    val port: Int = socket.localPort
    val outcome = CompletableDeferred<LoopbackRequest.Outcome>()

    @Volatile private var expectedState = ""
    @Volatile private var savedClientId: String? = null
    private val clients = Executors.newFixedThreadPool(MAXIMUM_CLIENTS)
    private val slots = Semaphore(MAXIMUM_CLIENTS)
    private val acceptor = Thread({ acceptClients() }, "ardia-chatgpt-loopback").apply { isDaemon = true }

    fun expect(state: String, savedClientId: String?) {
        expectedState = state
        this.savedClientId = savedClientId
        if (!acceptor.isAlive) acceptor.start()
    }

    fun stop() {
        runCatching { socket.close() }
        clients.shutdownNow()
    }

    private fun acceptClients() {
        while (!socket.isClosed) {
            val client = runCatching { socket.accept() }.getOrNull() ?: return
            if (!slots.tryAcquire()) {
                runCatching { client.close() }
                continue
            }
            runCatching {
                clients.execute {
                    try {
                        serve(client)
                    } finally {
                        slots.release()
                    }
                }
            }.onFailure {
                slots.release()
                runCatching { client.close() }
            }
        }
    }

    private fun serve(client: Socket) = client.use {
        runCatching {
            client.soTimeout = CLIENT_DEADLINE_MS
            val head = readHead(client) ?: return@runCatching
            var reply = LoopbackRequest.evaluate(head, port, expectedState, savedClientId)
            if (reply is LoopbackRequest.Reply.Finish && !outcome.complete(reply.outcome)) reply = LoopbackRequest.Reply.NotFound
            client.getOutputStream().apply {
                write(LoopbackRequest.response(reply))
                flush()
            }
            client.shutdownOutput()
        }
    }

    private fun readHead(client: Socket): String? {
        val input = client.getInputStream()
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(4096)
        val started = System.currentTimeMillis()
        while (buffer.size() < MAXIMUM_REQUEST_BYTES) {
            if (System.currentTimeMillis() - started > CLIENT_DEADLINE_MS) return null
            val count = input.read(chunk)
            if (count <= 0) return null
            buffer.write(chunk, 0, count)
            val text = buffer.toString(Charsets.UTF_8.name())
            val end = text.indexOf("\r\n\r\n")
            if (end >= 0) return text.substring(0, end)
        }
        return null
    }

    companion object {
        private const val MAXIMUM_REQUEST_BYTES = 16 * 1024
        private const val MAXIMUM_CLIENTS = 8
        private const val CLIENT_DEADLINE_MS = 10_000

        fun start(): LoopbackCallbackServer {
            val socket = ServerSocket()
            socket.reuseAddress = false
            socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), MAXIMUM_CLIENTS)
            return LoopbackCallbackServer(socket)
        }
    }
}
