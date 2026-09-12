首个版本。

模型目录的每一行多了两项：该模型的思考强度范围、该模型接受的输入模态。不用再让同一端点下的所有模型共用一套设置。

## 安装

```sh
dsh plugin --profile web add github:lengxiaoyu6/dsh-model-extended#v0.1.0
```

桌面版把 `web` 换成 `default`。跟随主线就去掉 `#v0.1.0`。

装完重启 dsh，刷新页面。

## 界面

展开任意一行模型，官方那两个容量字段旁边会多出两项。

DeepSeek 目录用适配器自己的四档：

```
Accepted input         [Text] [Image]
Reasoning efforts      [Off] [Low] [High] [Max] [No reasoning]   [Adapter default ▾]
```

自定义提供商（pi-ai）同样有这两项，档位改用该适配器的七档，多出 `Minimal`、`Medium`、`Xhigh`。

档位名由 id 直接拼出（`high` → `High`），和 dsh 自己的命名方式一致，模型选择器里显示的也是同一批名字。

**No reasoning** 显式声明该模型没有思考能力；再点一次撤销声明。没动过的模型保持原样，仍由适配器决定。

## 这两项不只是界面上的字

- 范围外的强度会在请求发出前被 dsh 运行时拒绝，报 `UNSUPPORTED_REASONING_EFFORT`。
- 输入模态进入模型选择器和请求准备流程。
- 声明随模型设置页原本的保存按钮落盘，与其它设置一起存在 `~/.dsh/settings.yaml`。插件自己不另存任何东西。

## 数据格式

两个编辑器写进的是各自适配器的 schema，所以字段不同。

DeepSeek 侧（`llm-deepseek`）是本插件定义的字段：

```yaml
llm-deepseek:
  models:
    - id: deepseek-v4.1-flash
      inputModalities: [text, image]
      reasoningEfforts: [low, high]
      defaultReasoningEffort: high        # 可省略
    - id: deepseek-v4-flash
      reasoningEfforts: false             # 该模型不支持思考
```

自定义提供商侧（`llm-pi-ai`）是 pi-ai 自己的字段，字段名是 `input` 而不是 `inputModalities`，档位表的值是请求真正发送的拼写：

```yaml
llm-pi-ai:
  providers:
    kiro:
      models:
        - id: claude-opus-4-6
          input: [text, image]
          reasoningEfforts:
            off:                     # 空值 = 支持"不思考"，不发该参数
            low: low
            high: high
```

界面按同一套词汇勾选，值就是档位名本身。需要别的拼写（例如某个网关要把 `max` 发成 `ultra`）就在 YAML 里直接改值。

## 卸载

补丁是插件在启动时打的，插件不在运行时没人能撤销它，所以先撤销再移除：

```sh
cd ~/.dsh/profiles/web && ./node_modules/.bin/dsh-model-extended revert
dsh plugin --profile web remove dsh-model-extended
```

`revert` 之后 bundle 与 dsh 原始文件逐字节一致。

## 这个版本包含

补丁覆盖两个编辑器，而不只是 DeepSeek 的：

- `DeepSeekModelsEditor` 用 `update(index, key, value)` 写草稿，插件包装适配器的 `resolveModel` 让声明在请求校验时生效。
- `ModelListEditor` 用 `patch(index, {key: value})` 写草稿，写的是 pi-ai 原生就认的字段，不需要叠加层——叠加层会把它读成"没有声明"从而覆盖适配器自己的答案，因此它只作用于 `llm-deepseek`。

两边的档位词汇不同，界面各说各的。清空全部档位会删掉字段而不是写空表：pi-ai 明确拒绝只有 `off` 的表，而"不声明"才是继承已装目录的正确说法。

140 项断言分三套。其中两条是这一版真正抓过 bug 的：把两个编辑器从打完补丁的 bundle 里整段抽出来真实渲染（作用域放错会当场抛错，而不是等打开设置页白屏），以及把界面实际写出的形状送进 pi-ai 真实的 `Config` schema。

需要本机装好 dsh；`./test/run-all.sh` 会自己从安装里解析 peer 依赖。
