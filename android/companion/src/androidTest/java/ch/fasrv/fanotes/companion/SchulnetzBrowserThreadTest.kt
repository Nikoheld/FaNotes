package ch.fasrv.fanotes.companion

import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(AndroidJUnit4::class)
class SchulnetzBrowserThreadTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private fun browser() = SchulnetzBrowser(instrumentation.targetContext, SchulnetzLog(instrumentation.targetContext.cacheDir))

    @Test fun creationNavigationAndDestructionUseMainThread() {
        val browser = browser()
        val navigated = CountDownLatch(1)
        val destroyed = CountDownLatch(1)
        val correctThread = AtomicBoolean(true)
        browser.webViewFactory = { context ->
            correctThread.set(Looper.myLooper() == Looper.getMainLooper())
            object : WebView(context) {
                override fun loadUrl(url: String) {
                    correctThread.compareAndSet(true, Looper.myLooper() == Looper.getMainLooper())
                    navigated.countDown()
                }
                override fun destroy() {
                    correctThread.compareAndSet(true, Looper.myLooper() == Looper.getMainLooper())
                    super.destroy()
                    destroyed.countDown()
                }
            }
        }
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<LoadedPage> { browser.load("https://www.schulnetz-ag.ch/aksa/") }
            assertTrue(navigated.await(10, TimeUnit.SECONDS))
            browser.dispose()
            assertEquals("cancelled", result.get(10, TimeUnit.SECONDS).error)
            assertTrue(destroyed.await(10, TimeUnit.SECONDS))
            assertTrue(correctThread.get())
        } finally {
            browser.dispose()
            executor.shutdownNow()
        }
    }

    @Test fun disposalCancelsQueuedCreation() {
        val browser = browser()
        val mainBlocked = CountDownLatch(1)
        val releaseMain = CountDownLatch(1)
        val created = AtomicBoolean(false)
        browser.webViewFactory = { context -> created.set(true); WebView(context) }
        Handler(Looper.getMainLooper()).post {
            mainBlocked.countDown()
            releaseMain.await(10, TimeUnit.SECONDS)
        }
        val executor = Executors.newSingleThreadExecutor()
        try {
            assertTrue(mainBlocked.await(5, TimeUnit.SECONDS))
            val result = executor.submit<LoadedPage> { browser.load("https://www.schulnetz-ag.ch/aksa/") }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (!browser.hasPendingLoad() && System.nanoTime() < deadline) Thread.yield()
            assertTrue(browser.hasPendingLoad())
            browser.dispose()
            releaseMain.countDown()
            assertEquals("cancelled", result.get(10, TimeUnit.SECONDS).error)
            instrumentation.waitForIdleSync()
            assertFalse(created.get())
        } finally {
            releaseMain.countDown()
            browser.dispose()
            executor.shutdownNow()
        }
    }
}
