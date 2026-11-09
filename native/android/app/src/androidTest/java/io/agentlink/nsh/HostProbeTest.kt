package io.agentlink.nsh

import android.view.View
import android.content.Intent
import android.view.ViewGroup
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostProbeTest {
    private fun descendants(view: View): List<View> = listOf(view) +
        if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()

    private fun waitText(scenario: ActivityScenario<MainActivity>, text: String) {
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            var found = false
            scenario.onActivity { activity ->
                found = descendants(activity.window.decorView).any { view ->
                    if (view is EditText) false else {
                        val node = view.createAccessibilityNodeInfo()
                        val matches = node.text?.toString() == text
                        node.recycle()
                        matches
                    }
                }
            }
            if (found) return
            Thread.sleep(100)
        }
        fail("Expected probe text did not appear: $text")
    }

    private fun press(scenario: ActivityScenario<MainActivity>, label: String) {
        scenario.onActivity { activity ->
            val button = descendants(activity.window.decorView).firstOrNull { it.contentDescription?.toString() == label }
            assertNotNull("Missing probe button", button)
            assertTrue(button!!.performClick())
        }
    }

    @Test fun hostEchoAndEncryptedReadSurviveRecreation() {
        val intent = Intent(InstrumentationRegistry.getInstrumentation().targetContext, MainActivity::class.java).putExtra("probe", true)
        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            waitText(scenario, "安卓宿主已就绪")
            scenario.onActivity { activity ->
                descendants(activity.window.decorView).filterIsInstance<EditText>().single().setText("人工测试：安卓输入")
            }
            waitText(scenario, "输入字符：9")
            press(scenario, "验证双向通信")
            waitText(scenario, "人工测试：安卓输入")
            waitText(scenario, "宿主事件：1")
            press(scenario, "加密保存测试文字")
            waitText(scenario, "测试文字已加密保存")
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val stored = context.getSharedPreferences("host_probe", 0).getString("ciphertext", "")!!
            assertFalse(stored.contains("人工测试"))
            assertFalse(stored.isEmpty())
            scenario.recreate()
            waitText(scenario, "安卓宿主已就绪")
            press(scenario, "读取测试文字")
            waitText(scenario, "人工测试：安卓输入")
            press(scenario, "验证双向通信")
            waitText(scenario, "宿主事件：1")
        }
    }
}
