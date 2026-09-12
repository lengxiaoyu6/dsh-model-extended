# dsh-model-extended

给 dsh 模型目录里的每一行模型，单独设置它的思考强度范围和输入模态。

## 为什么需要

dsh 的模型行只有四项：模型 ID、名称、上下文窗口、最大输出 token 数。思考强度（`reasoningEffort`）不在行里，它是连接级的开关，同一个端点下的所有模型共用 `off / low / high / max` 四档。

现实里这四档常常对不上：有的模型只支持其中两档，有的压根不支持思考，但界面照样给全套，选了之后要么被服务端拒掉，要么静默无效。输入模态同理，只能整条连接地配，没法在模型这一级区分。

这个插件把这两项挪回模型行自己身上。

## 界面

展开任意一行模型，官方那两个容量字段旁边会多出两项。以下是 DeepSeek 目录（`DeepSeekModelsEditor`）：

```
模型 ID                名称
[deepseek-v4.1-flash] [DeepSeek-V41-Flash]          ⌄   🗑

上下文窗口              最大输出 token 数
[1M]                   [256K]
Accepted input         [Text] [Image]
Reasoning efforts      [Off] [Low] [High] [Max] [No reasoning]   [Adapter default ▾]
```

自定义提供商（`ModelListEditor`）同样有这两项，档位改用该适配器自己的词汇表（多出 `Minimal`、`Medium`、`Xhigh`）。

**Accepted input** 勾选该模型接受的请求模态。

**Reasoning efforts** 勾选它真正支持的档位。DeepSeek 目录下勾选后会出现一个下拉框选默认档，留空即跟随适配器。

**No reasoning** 显式声明该模型没有思考能力，此时上面的档位全部禁用。再点一次则撤销该声明。

没动过的模型一律保持原样，仍然由适配器决定。

档位名由 id 直接拼出（`high` → `High`），和 dsh 自己的命名方式一致，模型选择器里显示的也是同一批名字。这些名字不随界面语言变化——它们是适配器词汇，不是界面文案，换一种叫法就会和选中的档位对不上。本插件自己新增的字段标签固定为英文。

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

两个编辑器写的字段不同，因为它们写进的是各自的适配器 schema。

**DeepSeek 目录**（`llm-deepseek`）用本插件定义的三个字段，跟其它设置一起存在 `~/.dsh/settings.yaml`，用模型设置页原本的保存按钮保存：

```yaml
llm-deepseek:
  models:
    - id: deepseek-v4.1-flash
      name: DeepSeek-V41-Flash
      contextWindow: 1000000
      inputModalities: [text, image]      # Accepted input
      reasoningEfforts: [low, high]       # Reasoning efforts
      defaultReasoningEffort: high        # 默认档位，可省略
    - id: deepseek-v4-flash
      reasoningEfforts: false             # 显式声明：该模型不支持思考
```

- `reasoningEfforts`：字符串数组表示支持的档位；`false` 表示明确不支持思考；不写就交给适配器
- `defaultReasoningEffort`：省略、或者不在范围内的值时，运行时保留适配器自己的默认
- `inputModalities`：支持的输入；不写就交给适配器

档位词汇是 DeepSeek 适配器自己的 `off / low / high / max`。范围外的档位和未知模态在写入和读取两侧都会被过滤掉，不会进设置，也不会到运行时。

**自定义提供商**（`llm-pi-ai`）写的是 pi-ai 自己的字段，不是上面这套：

```yaml
llm-pi-ai:
  providers:
    kiro:
      models:
        - id: claude-opus-4-6
          input: [text, image]
          reasoningEfforts:          # 档位 → 请求里发的拼写
            off:                     # 空值 = 支持"不思考"，不发该参数
            low: low
            high: high
        - id: claude-haiku-4-5-20251001
          reasoningEfforts: false
```

字段名是 `input` 而不是 `inputModalities`，档位表是 pi-ai 的七档（`off / minimal / low / medium / high / xhigh / max`），值是请求真正发送的拼写。界面按同一套词汇勾选，值就是档位名本身；需要别的拼写（例如某个网关要把 `max` 发成 `ultra`）就在 YAML 里直接改值——那里看得见。清空全部档位会删掉这个字段，而不是写一个空表：pi-ai 明确拒绝只有 `off` 的表，而"不声明"才是继承已装目录的正确说法。

## 实现

要做成两件事：字段得能填，填了得算数。

**字段**。dsh 没有提供模型行内部的外部扩展位，`settings.models.provider-card` 只能加在供应商卡片旁边，加不进模型行；而官方两个编辑器都只渲染那四个字段。所以 `lib/patch.js` 直接把控件插进编辑器 bundle，两个编辑器各一份：`DeepSeekModelsEditor` 和 `ModelListEditor`。

补丁只做很小的改动，因为官方编辑器已经把剩下的部分做好了：

- `update(index, key, value)`（DeepSeek）和 `patch(index, {key: value})`（pi-ai）都能往草稿写任意 key，传 `undefined` 就是删掉它。声明因此搭上编辑器自己的草稿，由官方自己的保存路径落盘，插件不需要另外存任何东西。
- 两个编辑器的草稿类型都是 `Record<string, unknown>`（`ModelDraft = DeepSeekModelDraft`），官方有意保持开放以免编辑时丢字段。额外字段能原样往返，不用改任何官方代码。

五个插入点在发布的 bundle 里都是唯一字符串，所以补丁是五次字面替换，要么整体成功，要么拒绝并保持文件不动。共享的辅助（档位表、chip、字段布局）注入在两个编辑器区段之间的模块作用域，各自的渲染函数注入到自己所属的函数体内——`t`、`disabled`、`patch` 都是函数体局部变量，放错作用域会编译通过、然后在打开设置页时抛 `t is not defined`。

插进去的代码只用插入点上本就可见的名字（`props`、`update`、`patch`、`react_jsx_runtime`、`ModelsSection_module_css_default`），主题变量也跟着页面走，所以它看起来就是官方的一部分。

**生效**。`ctx.llm` 解析某个模型的确切元数据时，会调用该路由适配器的 `resolveModel`（`LlmRuntime.resolveModelInfoFor` → `registration.adapter.resolveModel`），请求发出前校验强度的也是同一个调用。所以插件包装已注册适配器实例的 `resolveModel` 和 `listModels`，在适配器的结果上叠加声明。一个接缝同时覆盖模型选择器和请求校验，也不用克隆适配器。

有一点值得记下来：`ctx.llm.adapters` 存的是每条路由的 registration（`{adapter, provider, retryPolicy}`），不是适配器本身，得往里解一层才是真正持有 `resolveModel` 的对象。

适配器注册比插件加载晚，所以拓扑事件 `llm/adapters-updated` 每次都会重新扫描并包装，包装本身是幂等的。路由到设置命名空间的对应关系来自适配器自己的目录声明，插件不硬编码任何 provider id。

## 失败时会怎样

- 上游编辑器结构变了，锚点找不到：报告出来，文件保持原样。结果是"没有这两个字段"，不是白屏。
- 补丁任何一步失败都不抛异常，不影响 dsh 启动。
- 撤销不依赖备份文件，是同样五个字面量的反向替换，所以升级覆盖掉备份之后照样能撤销。撤销会把官方 `capacityField` 和 `CAPACITY_HINT` 的定义还原回去，而不是删掉。
- 如果磁盘上的补丁来自更早的版本（字面量与当前版本不同），字面量反向替换匹配不上，此时回退到备份文件——那是首次打补丁前留下的原文。
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

`namespaces` 是允许叠加层读取声明的设置命名空间，每个都得是有 `models` 数组的命名空间。它默认只有 `llm-deepseek`，而且不应该是别的：pi-ai 自己声明并解析 `reasoningEfforts` 与 `input`，叠加层会把那张档位表读成"没有声明"从而覆盖掉适配器自己的答案。（编辑器补丁不受这里影响，两个编辑器的字段都会出现。）

## 限制

- 叠加层只对通过设置命名空间配置的 provider 生效。声明存在 settings 段里，插件靠 `llm/listConfigurableProviders` 把路由映射到命名空间；没有这个映射的路由保持适配器原样。
- DeepSeek 侧的档位词汇是那四档，写死在 `EFFORT_LEVELS` 和 bundle 里的 `__msEffortIds`。适配器以后加了新档位，两处都要同步。（pi-ai 侧没有这个问题：档位表来自它的词汇，并且按 id 派生名字。）

## 测试

```sh
./test/run-all.sh
```

需要本机装好 dsh：`test/e2e.mjs` 要拿 dsh 自己的 `LlmRuntime` 和 pi-ai 的 `Config` schema 跑，`test/patch.mjs` 要拿 dsh 发布的模型编辑器 bundle 做补丁。`test/link-peers.mjs` 会从本机 dsh 里把这些解析出来，把 peer 链接建好；`node_modules/` 已 gitignore，新克隆需要这一步，`run-all.sh` 已经带上了。

140 项断言，分三套：

- `test/patch.mjs`（96 项）：补丁的应用、幂等、备份、撤销的字节级可逆性、打完和撤销后仍是合法 JS、锚点缺失时拒绝且不改文件。注入的渲染函数放进假 JSX 运行时真跑，检查选中态、点击写入、默认档下拉、越界值被忽略、禁用态。另外把两个编辑器**从打完补丁的 bundle 里整段抽出来真实渲染**一遍：自由变量按模块真实解析，所以注入点放错作用域会在这里就抛出来，而不是等到打开设置页白屏。
- `test/host.mjs`（26 项）：叠加层。范围生效、未声明不动、显式否定、非法值过滤、越界默认丢弃、拓扑重扫与幂等、没有命名空间的 provider 不受影响、插件禁用时零副作用，以及在运行中改设置**立刻生效**（这条曾经是坏的：查找函数把设置快照在包装时刻，改完必须重启）。
- `test/e2e.mjs`（18 项）：接真实的运行时。叠加后的元数据要通过 dsh `LlmRuntime` 自己的校验，范围外的强度要被真实拒绝。自定义提供商那侧则把界面实际写出的形状送进 pi-ai 真实的 `Config` schema——`reasoningEfforts` 写数组会被它直接拒绝，这一条守住的就是那个 bug。

除 `patch.mjs` 在自己的沙箱副本上工作外，另外两套也把补丁重定向到临时副本。任何测试都不会改到 dsh 的安装。

## 许可

MIT
