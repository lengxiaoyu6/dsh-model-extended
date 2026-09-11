# dsh-model-extended

在 dsh 的 **设置 → 模型目录** 里，直接给每一行模型设置它的**思考强度范围**与**支持的输入模态**。

dsh 原生的模型行只有 `模型 ID / 名称 / 上下文窗口 / 最大输出 token 数`，而思考强度（`reasoningEffort`）是**连接级**的全局开关 —— 一个端点上的所有模型共用同一组 `off | low | high | max`，哪怕某个模型实际只支持其中两档，或者根本不支持思考。这个插件把这两项能力交还给每一行模型自己。

## 它做了什么

模型行展开后，除了官方的两个容量字段，还会多出两个字段：

```
模型 ID                名称
[deepseek-v4.1-flash] [DeepSeek-V41-Flash]        ⌄  🗑

支持的输入       [文本] [图像]
思考强度范围     [关闭] [低] [高] [最高] [不支持思考]  [跟随适配器 ▾]
```

- **支持的输入** —— 该模型接受的请求模态
- **思考强度范围** —— 该模型真正支持的档位；再选一个其中的默认档，或"跟随适配器"
- **不支持思考** —— 显式声明该模型没有思考能力

没有做任何声明的模型，行为**完全不变**，一切仍由适配器决定。

声明不只是 UI。范围外的强度会在请求发出前被运行时拒绝（`UNSUPPORTED_REASONING_EFFORT`），输入模态则进入模型选择器与请求准备链路。

## 安装

```bash
dsh plugin --profile web add dsh-model-extended@link:/root/code/dsh-plugin/dsh-model-extended
```

`dsh plugin` 会把包加入 `dsh.profile.bundles`（本插件的 `cordis.patch.yml` 会被自动合并）。**重启 dsh 后生效**；重启后刷新页面即可看到新字段。

## 数据格式

声明是模型条目上的额外字段，随 `~/.dsh/settings.yaml` 一起存，用**官方保存按钮**保存：

```yaml
llm-deepseek:
  models:
    - id: deepseek-v4.1-flash
      name: DeepSeek-V41-Flash
      contextWindow: 1000000
      inputModalities: [text, image]      # 支持的输入
      reasoningEfforts: [low, high]       # 思考强度范围
      defaultReasoningEffort: high        # 默认档位（省略 = 跟随适配器）
    - id: deepseek-v4-flash
      reasoningEfforts: false             # 显式声明：该模型不支持思考
```

三个字段都可选，也都可以直接手写：

- `reasoningEfforts`：字符串数组 = 支持的档位；`false` = 显式不支持；缺省 = 交给适配器
- `defaultReasoningEffort`：省略或不在范围内时，运行时保留适配器自己的默认
- `inputModalities`：支持的输入；缺省 = 交给适配器

档位词汇沿用的是适配器自己的 `off | low | high | max`。范围外的值、未知模态在写入与读取两侧都会被规范化过滤，不会进入设置，也不会到达运行时。

## 架构

两件事，一个目标：让人**能填**，并且填的东西**算数**。

**字段从哪来。** dsh 没有提供模型行内部的外部扩展位 —— `settings.models.provider-card` 只能在供应商卡片**旁边**加区域，加不进模型**行**里，而官方 `DeepSeekModelsEditor` 只渲染 `id / name / contextWindow / maxTokens`。所以真正属于模型条目的字段，由 `lib/patch.js` 放进官方编辑器自己的 bundle 里：两个控件追加到每行的展开区，紧挨着官方那两个容量字段。

补丁刻意做得很小，因为官方编辑器已经把难的部分做完了：

- `update(index, key, value)` 能把任意 key 写进草稿，`undefined` 即删除该 key —— 所以声明**搭上编辑器自己的草稿**、由**官方自己的保存路径**持久化，本插件不存任何东西
- `DeepSeekModelDraft` 是 `Record<string, unknown>`，官方明确保持其开放以免编辑时丢字段 —— 所以额外字段能原样往返，无需改动任何官方代码

两个插入点在随包发布的 bundle 里都是**唯一字符串**，所以补丁是两步字面替换：要么整体成功，要么拒绝并保持文件原样。插进 bundle 的代码只使用插入点本就可见的名字（`props`、`update`、`react_jsx_runtime`、`ModelsSection_module_css_default`），并与页面共用同一套主题变量与语言。

**声明如何生效。** `ctx.llm` 解析某个模型的确切元数据时，会调用该路由适配器的 `resolveModel`（`LlmRuntime.resolveModelInfoFor` → `registration.adapter.resolveModel`），而同一个调用也是请求发出前校验强度的依据。所以插件包装**已注册适配器实例**的 `resolveModel` 与 `listModels`，在适配器的答案之上叠加声明 —— 一个接缝，同时覆盖模型选择器与请求校验，且不克隆适配器。

适配器注册表 `ctx.llm.adapters` 存的是每条路由的 registration（`{adapter, provider, retryPolicy}`），不是适配器本身，插件据此解引用。适配器注册晚于插件加载，因此拓扑事件 `llm/adapters-updated` 每次都会重新扫描并包装（幂等，重复触发不会叠加包装）。路由→设置命名空间的映射来自适配器自己的目录声明，插件不硬编码任何 provider id。

## 安全与失败姿态

- **改的是已安装的 dsh 文件**，所以补丁在写入前会在旁边留一份 `<bundle>.dsh-model-extended.bak`（只留一次）
- 撤销不依赖备份：它是同样两个字面量的反向替换，因此升级覆盖备份后仍能撤销。撤销会把官方 `capacityField` 定义**还原**（而不是删掉），保证页面完整
- 上游编辑器结构变了（锚点找不到）→ 报告并**保持文件原样**，结果是"没有这两个字段"，而不是白屏
- 补丁的任何失败都不抛异常，绝不影响 dsh 启动
- `config.patchEditor: false` 可整体关闭补丁，只保留叠加层

## 边界

- 只对**通过设置命名空间配置**的 provider 生效：声明存在 settings 段里，插件靠 `llm/listConfigurableProviders` 把路由映射到命名空间；没有这个映射的路由保持适配器原样
- 默认只作用于 `llm-deepseek`；要在别的命名空间启用，改 `cordis.patch.yml` 里的 `config.namespaces`
- 档位词汇目前是 DeepSeek 适配器的四档；适配器若引入新档位，需要同步 `EFFORT_LEVELS` 与 bundle 里的 `__msEffortIds`

## 测试

```bash
./test/run-all.sh
```

三层验证，共 102 项断言：

- `test/patch.mjs` — 编辑器补丁：应用、幂等、备份、**撤销的字节级可逆性**、补丁后与撤销后仍为合法 JS、锚点缺失时拒绝且不改文件；并把注入的渲染函数放进假 JSX 运行时**真的跑一遍** —— 档位/模态的选中态、点击写入草稿、默认档选择器、越界值忽略、中英文案、禁用态
- `test/host.mjs` — 适配器叠加：范围生效、未声明不动、显式否定、非法值过滤、越界默认丢弃、拓扑重扫与幂等、无命名空间路由不受影响、禁用时零副作用
- `test/e2e.mjs` — 接入**真实** `@deepseek-ai/dsh-llm` 运行时：叠加后的元数据通过运行时自己的校验，且范围外的强度被**真实拒绝**（`UNSUPPORTED_REASONING_EFFORT`）

除 `patch.mjs` 在自己的沙箱副本上工作外，另两层测试也把补丁重定向到临时副本，**任何测试都不会改到 dsh 的安装**。

`test/e2e.mjs` 用 `node_modules/@deepseek-ai/` 下的 peer 链接解析 dsh 自己的包。

## 许可

MIT
