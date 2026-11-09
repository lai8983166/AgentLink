package io.agentlink.nsh

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import com.longbridge.nsh.NshView
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var view: NshView
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var closed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        view = NshView(this)
        view.setStorageDirectory(java.io.File(filesDir, "nsh"))
        view.setGrantedCapabilities("""{"host":["probe.ready","probe.echo","probe.save","probe.read"]}""")
        view.setErrorListener { showFailure() }
        view.handle("probe.ready") { _, reply -> reply.resolve(true) }
        view.handle("probe.echo") { data, reply ->
            val text = data as? String
            if (text == null || text.length > 8192) reply.reject("Invalid probe text")
            else {
                view.send("probe.echoed", null)
                reply.resolve(text)
            }
        }
        view.handle("probe.save") { data, reply ->
            val text = data as? String
            if (text == null || text.length > 8192) reply.reject("Invalid probe text")
            else executor.execute {
                try {
                    ProbeStore(this).save(text)
                    if (!closed) reply.resolve("测试文字已加密保存")
                } catch (_: Exception) { if (!closed) reply.reject("Probe storage failed") }
            }
        }
        view.handle("probe.read") { _, reply ->
            executor.execute {
                try {
                    val value = ProbeStore(this).read()
                    if (!closed) reply.resolve(value ?: "尚未保存测试文字")
                } catch (_: Exception) { if (!closed) reply.reject("Probe storage failed") }
            }
        }
        setContentView(view)
        if (!view.loadAssetBundle("nsh")) showFailure()
    }

    private fun showFailure() {
        // Never forward VM exception text to logs: future screens may contain secrets.
        runOnUiThread {
            if (!closed) setContentView(TextView(this).apply {
                text = "NSH 界面加载失败，请重新安装验证包"
                setPadding(32, 64, 32, 32)
            })
        }
    }

    override fun onDestroy() {
        closed = true
        view.destroy()
        executor.shutdownNow()
        super.onDestroy()
    }
}
