# 双客户端视觉主题

默认使用 **朋克拼贴（punk-collage）**，原有 **classic** 样式继续保留。应用不提供主题按钮、设置项或存储偏好，两个客户端始终使用同一个构建选择。

## 参考与实现

参考 [UILIB 朋克拼贴主题](https://github.com/lai8983166/UILIB/blob/14e4e9cd07d8600494ce99711e8bb028842076a9/src/styles/themes/punk-collage.css) 及其性能说明（参考提交 `14e4e9cd07d8600494ce99711e8bb028842076a9`）。提取其红/黑/白、纸底半调、切角、粗墨边、硬阴影、斜标题与红色划痕方向，在 AgentLink 中独立实现；不引入 Vue、整套组件库或远程运行时依赖。

- 红色主要操作/选中项，黑白消息与面板；黄色审批、绿色完成等状态保留区分与文字标签。
- 两版使用统一的主题配置和内联样式适配。配对、首页/目录、详情/审批/工具/差异、新任务、设置、审计均覆盖。
- 只倾斜标题和装饰，不倾斜输入框、消息正文或滚动容器，不更改控件能力与业务协议。
- 装饰不接收指针事件；不使用多层动态 drop-shadow、模糊或全屏动画。NSH 以静态 SVG 纸纹和切角适配，不引入网页渲染。

## 保留与恢复旧样式

唯一选择在 `shared/src/ui-theme.ts` 的 `ACTIVE_UI_THEME`。开发时将它改为 `classic` 并重新构建两版即可恢复；发布默认保持 `punk-collage`。

`web/src/theme.css` 原文件保留，新 CSS 在 `web/src/themes/punk-collage.css` 中以主题属性限定作用范围。原有内联样式保留，由 `themedStyle` 在朋克构建中适配；classic 分支原样返回，且不修改传入对象。NSH 共用这一选择，装饰在 classic 中不渲染。两套主题共享功能逻辑，避免复制页面后逐渐失去同步。

不要通过增加应用设置、localStorage 主题值、系统深浅色或后台配置来改变这个约定。

## 验证

- 主题单元测试验证旧样式原样返回、适配幂等、布局/点击尺寸保持与状态区分。
- Web 页面单元与移动端 E2E 检查输入法视口、目录导航、刷新、下载及没有主题切换入口。
- NSH 页面交互与人工数据截图检查所有页面；可在隔离副本中复验旧主题：

```bash
node native/scripts/visual-review.mjs /path/to/browser
node native/scripts/visual-review.mjs --classic /path/to/browser
```

截图仅保存在忽略目录，不使用真实会话。Web 与 NSH 的渲染引擎存在字体回退、网点和系统控件差异；浏览器预览不替代安卓手机的字体、键盘、安全区与滚动性能验收。交付时两版均更新版本、签名 APK 及各自后台下载入口。
