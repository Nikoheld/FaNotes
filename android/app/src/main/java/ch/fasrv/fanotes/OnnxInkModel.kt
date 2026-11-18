package ch.fasrv.fanotes

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.File
import java.nio.FloatBuffer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * The desktop's FaNotes ink line model (`ink.onnx`) in ONNX Runtime for Android, with the session
 * options of the desktop `fanotes-ocr` sidecar (`crates/fanotes-ort/src/session.rs`): CPU, sequential,
 * all graph optimizations, memory arena and pattern, 1–4 intra-op threads, one inter-op thread.
 *
 * The session opens on the first line, on this class's own thread, and closes after a minute
 * without work, so the ~100 MB it holds is not kept while the writer only writes.
 */
class OnnxInkModel(private val modelFile: () -> File?) {
    private val worker = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "fanotes-ink-onnx").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1 }
    }
    private var session: OrtSession? = null
    private var sessionPath: String? = null
    private var idle: ScheduledFuture<*>? = null

    class Output(val logits: FloatArray, val dims: LongArray)

    /** Blocks the calling (bridge) thread until the line is read; the model runs on the worker. */
    fun run(input: FloatArray, width: Int, height: Int, threads: Int): Output {
        require(height == MODEL_HEIGHT && width in 16..4096 && input.size == width * height) { "Die native OCR-Eingabe ist ungültig." }
        return worker.submit<Output> {
            idle?.cancel(false)
            try {
                val active = open(threads)
                val environment = OrtEnvironment.getEnvironment()
                OnnxTensor.createTensor(environment, FloatBuffer.wrap(input), longArrayOf(1, 1, height.toLong(), width.toLong())).use { tensor ->
                    active.run(mapOf(INPUT_NAME to tensor)).use { result ->
                        val value = (result.get(OUTPUT_NAME).orElse(null) ?: result.get(0)) as? OnnxTensor
                            ?: throw IllegalStateException("Die native Stifterkennung hat kein lesbares Ergebnis geliefert.")
                        val dims = value.info.shape
                        if (dims.size != 3) throw IllegalStateException("Die native Stifterkennung hat kein lesbares Ergebnis geliefert.")
                        val buffer = value.floatBuffer
                        val logits = FloatArray(buffer.remaining())
                        buffer.get(logits)
                        Output(logits, dims)
                    }
                }
            } finally {
                idle = worker.schedule({ close() }, IDLE_MS, TimeUnit.MILLISECONDS)
            }
        }.get()
    }

    private fun open(threads: Int): OrtSession {
        val file = modelFile() ?: throw IllegalStateException("Das Handschriftmodell ist auf diesem Gerät nicht installiert.")
        session?.let { if (sessionPath == file.path) return it }
        close()
        val options = OrtSession.SessionOptions().apply {
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
            setIntraOpNumThreads(threads.coerceIn(1, 4))
            setInterOpNumThreads(1)
            setMemoryPatternOptimization(true)
            setCPUArenaAllocator(true)
        }
        val environment = OrtEnvironment.getEnvironment()
        // No usage telemetry: the app manifest also removes ORT's telemetry provider.
        runCatching { environment.setTelemetry(false) }
        val created = environment.createSession(file.path, options)
        session = created
        sessionPath = file.path
        return created
    }

    /** Frees the session (idle timer, model removal). Safe from any thread. */
    fun release() {
        worker.execute { close() }
    }

    private fun close() {
        runCatching { session?.close() }
        session = null
        sessionPath = null
    }

    companion object {
        const val MODEL_HEIGHT = 64
        private const val INPUT_NAME = "image"
        private const val OUTPUT_NAME = "logits"
        private const val IDLE_MS = 60_000L

        /** `effectiveOcrThreadCount` on the desktop keeps half the cores free; at most four. */
        fun defaultThreads(): Int = (Runtime.getRuntime().availableProcessors() / 2).coerceIn(1, 4)
    }
}
