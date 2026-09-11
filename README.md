# dsh-model-extended

给 dsh 模型目录里的每一行模型，单独设置它的思考强度范围和输入模态。

## 为什么需要

dsh 的模型行只有四项：模型 ID、名称、上下文窗口、最大输出 token 数。思考强度（`reasoningEffort`）不在行里，它是连接级的开关，同一个端点下的所有模型共用 `off / low / high / max` 四档。

现实里这四档常常对不上：有的模型只支持其中两档，有的压根不支持思考，但界面照样给全套，选了之后要么被服务端拒掉，要么静默无效。输入模态同理，只能整条连接地配，没法在模型这一级区分。

这个插件把这两项挪回模型行自己身上。

## 界面

展开任意一行模型，官方那两个容量字段旁边会多出两项：

```
模型 ID                名称
[deepseek-v4.1-flash] [DeepSeek-V41-Flash]          ⌄   🗑

上下文窗口              最大输出 token 数
[1M]                   [256K]
支持的输入              [文本] [图像]
思考强度范围            [关闭] [低] [高] [最高] [不支持思考]   [跟随适配器 ▾]
```

**支持的输入** 勾选该模型接受的请求模态。

**思考强度范围** 勾选它真正支持的档位。勾了之后会多出一个下拉框选默认档，留空就是跟随适配器。

**不支持思考** 显式声明该模型没有思考能力，此时上面的档位全部禁用。

没动过的模型一律保持原样，仍然由适配器决定。

这两项不只是界面上的字。范围外的强度会在请求发出前被运行时拒绝，报 `UNSUPPORTED_REASONING_EFFORT`；输入模态会进入模型选择器和请求准备流程。

## 安装

需要本机已经装好 dsh。

```sh
git clone https://github.com/lengxiaoyu6/dsh-model-extended.git
cd dsh-model-extended

# Web
dsh plugin --profile web add .

# 桌面
dsh plugin --profile default add .
```

不克隆也行，直接装仓库：

```sh
# Web
dsh plugin --profile web add github:lengxiaoyu6/dsh-model-extended

# 桌面
dsh plugin --profile default add github:lengxiaoyu6/dsh-model-extended
```

`git+https://github.com/lengxiaoyu6/dsh-model-extended.git` 也能装（注意用 `.tar.gz` 归档地址，`.zip` 会被 pnpm 当 tarball 解压而失败）。

`dsh plugin add` 会把包装进 profile 的依赖，并把这个插件的 `cordis.patch.yml` 合进 bundle 栈，不用手改 profile 配置。

装完重启 dsh，再刷新页面。

第一次启动时插件会改动 dsh 内置的模型编辑器文件，改动前会在旁边留一份 `.dsh-model-extended.bak`。

## 卸载

插件不在运行时没人能撤销它打的补丁，所以先撤销，再移除：

```sh
# 从克隆目录
node bin/dsh-model-extended.js revert

# 或者从装了插件的 profile 里
cd ~/.dsh/profiles/web && ./node_modules/.bin/dsh-model-extended revert

dsh plugin --profile web remove dsh-model-extended
```

`revert` 之后 bundle 与 dsh 原始文件逐字节一致，有测试守着这一点。撤销前可以先看状态，把 `revert` 换成 `status` 即可。

## 数据格式

声明就是模型条目上的几个额外字段，跟其它设置一起存在 `~/.dsh/settings.yaml`，用模型设置页原本的保存按钮保存：

```yaml
llm-deepseek:
  models:
    - id: deepseek-v4.1-flash
      name: DeepSeek-V41-Flash
      contextWindow: 1000000
      inputModalities: [text, image]      # 支持的输入
      reasoningEfforts: [low, high]       # 思考强度范围
      defaultReasoningEffort: high        # 默认档位，可省略
    - id: deepseek-v4-flash
      reasoningEfforts: false             # 显式声明：该模型不支持思考
```

三个字段都是可选的，手写也完全可以：

- `reasoningEfforts`：字符串数组表示支持的档位；`false` 表示明确不支持思考；不写就交给适配器
- `defaultReasoningEffort`：省略、或者不在范围内的值时，运行时保留适配器自己的默认
- `inputModalities`：支持的输入；不写就交给适配器

档位词汇沿用适配器自己的 `off / low / high / max`。范围外的档位和未知模态在写入和读取两侧都会被过滤掉，不会进设置，也不会到运行时。

## 实现

要做成两件事：字段得能填，填了得算数。

**字段**。dsh 没有提供模型行内部的外部扩展位，`settings.models.provider-card` 只能加在供应商卡片旁边，加不进模型行；官方的 `DeepSeekModelsEditor` 也只渲染那四个字段。所以 `lib/patch.js` 直接把控件插进官方编辑器的 bundle：两个控件追加到每行的展开区，渲染函数声明在官方 `capacityField` 旁边。

补丁只做很小的改动，因为官方编辑器已经把剩下的部分做好了：

- `update(index, key, value)` 能往草稿写任意 key，传 `undefined` 就是删掉它。声明因此搭上编辑器自己的草稿，由官方自己的保存路径落盘，插件不需要另外存任何东西。
- `DeepSeekModelDraft` 的类型是 `Record<string, unknown>`，官方有意保持开放以免编辑时丢字段。额外字段能原样往返，不用改任何官方代码。

两个插入点在发布的 bundle 里都是唯一字符串，所以补丁是两次字面替换，要么整体成功，要么拒绝并保持文件不动。插进去的代码只用插入点上本就可见的名字（`props`、`update`、`react_jsx_runtime`、`ModelsSection_module_css_default`），主题变量和语言也跟着页面走，所以它看起来就是官方的一部分。

**生效**。`ctx.llm` 解析某个模型的确切元数据时，会调用该路由适配器的 `resolveModel`（`LlmRuntime.resolveModelInfoFor` → `registration.adapter.resolveModel`），请求发出前校验强度的也是同一个调用。所以插件包装已注册适配器实例的 `resolveModel` 和 `listModels`，在适配器的结果上叠加声明。一个接缝同时覆盖模型选择器和请求校验，也不用克隆适配器。

有一点值得记下来：`ctx.llm.adapters` 存的是每条路由的 registration（`{adapter, provider, retryPolicy}`），不是适配器本身，得往里解一层才是真正持有 `resolveModel` 的对象。

适配器注册比插件加载晚，所以拓扑事件 `llm/adapters-updated` 每次都会重新扫描并包装，包装本身是幂等的。路由到设置命名空间的对应关系来自适配器自己的目录声明，插件不硬编码任何 provider id。

## 失败时会怎样

- 上游编辑器结构变了，锚点找不到：报告出来，文件保持原样。结果是"没有这两个字段"，不是白屏。
- 补丁任何一步失败都不抛异常，不影响 dsh 启动。
- 撤销不依赖备份文件，是同样两个字面量的反向替换，所以升级覆盖掉备份之后照样能撤销。撤销时会把官方 `capacityField` 的定义还原回去，而不是删掉。
- `config.patchEditor: false` 可以整个关掉补丁，只留叠加层。

## 配置

插件的 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-model-extended
      name: 'dsh-model-extended'
      config:
        enabled: true
        patchEditor: true
        namespaces:
          - llm-deepseek
```

`namespaces` 是允许承载这些声明的设置命名空间，每个都得是有 `models` 数组的命名空间。

## 限制

- 只对通过设置命名空间配置的 provider 生效。声明存在 settings 段里，插件靠 `llm/listConfigurableProviders` 把路由映射到命名空间；没有这个映射的路由保持适配器原样。
- 默认只作用于 `llm-deepseek`，别的命名空间要自己加到 `namespaces` 里。
- 档位词汇目前是 DeepSeek 适配器的四档。适配器以后加了新档位，`EFFORT_LEVELS` 和 bundle 里的 `__msEffortIds` 都要同步。

## 测试

```sh
./test/run-all.sh
```

需要本机装好 dsh：`test/e2e.mjs` 要拿 dsh 自己的 `LlmRuntime` 跑，`test/patch.mjs` 要拿 dsh 发布的模型编辑器 bundle 做补丁。`test/link-peers.mjs` 会从本机 dsh 里把这些解析出来，把 peer 链接建好；`node_modules/` 已 gitignore，新克隆需要这一步，`run-all.sh` 已经带上了。

90 项断言，分三套：

- `test/patch.mjs`（52 项）：补丁的应用、幂等、备份、撤销的字节级可逆性、打完和撤销后仍是合法 JS、锚点缺失时拒绝且不改文件。另外把注入的渲染函数放进一个假的 JSX 运行时真跑一遍，检查档位和模态的选中态、点击写入草稿、默认档下拉、越界值被忽略、中英文案、禁用态。
- `test/host.mjs`（26 项）：叠加层。范围生效、未声明不动、显式否定、非法值过滤、越界默认丢弃、拓扑重扫与幂等、没有命名空间的 provider 不受影响、插件禁用时零副作用，以及在运行中改设置**立刻生效**（这条曾经是坏的：查找函数把设置快照在包装时刻，改完必须重启）。
- `test/e2e.mjs`（12 项）：接真实的 `@deepseek-ai/dsh-llm` 运行时。叠加后的元数据要通过运行时自己的校验，范围外的强度要被真实拒绝。

除 `patch.mjs` 在自己的沙箱副本上工作外，另外两套也把补丁重定向到临时副本。任何测试都不会改到 dsh 的安装。

## 许可

MIT
