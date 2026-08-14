# WebGPU DeepSeek 学习笔记

这个项目记录在浏览器中使用 Transformers.js 加载 DeepSeek-R1 Distill Qwen，并通过 WebGPU 完成本地文本生成的学习过程。模型和推理都在浏览器端运行，模型文件首次使用时下载到浏览器缓存，之后可以复用缓存进行推理。

## 一、技术链路

### Hugging Face

Hugging Face 是 AI 领域常用的开源模型社区，各个模型厂商会在这里发布模型、配置和分词器文件。ModelScope 也提供类似的模型托管能力。

本项目使用的模型链路是：

```text
DeepSeek-R1-Distill-Qwen-1.5B-ONNX
        -> Hugging Face 模型仓库
        -> Transformers.js 下载并加载
        -> 浏览器本地缓存
        -> WebGPU 执行推理
        -> 页面流式展示回答
```

模型文件体积较大，首次加载需要等待下载；下载完成后，浏览器会保留缓存，后续启动可以减少重复下载。

### Transformers.js

Transformers.js 是 Transformers 的 JavaScript 版本，用于在浏览器环境中加载模型、分词器并执行 NLP 任务。当前项目使用 `@huggingface/transformers` 的 `AutoTokenizer`、`AutoModelForCausalLM` 和 `TextStreamer` 完成文本生成。

## 二、项目依赖

- `@huggingface/transformers`
  - 加载模型和分词器，并调用模型推理。
  - 通过 `device: "webgpu"` 将计算交给浏览器的 WebGPU 后端。
- `marked`
  - 模型输出通常是 Markdown 文本，可以表示代码、加粗、引用等结构。
  - 页面展示前需要把 Markdown 转换为 HTML。
- `dompurify`
  - 对转换后的 HTML 做清理，避免把模型输出中的危险标签直接插入页面。
- `@webgpu/types`
  - 如果 TypeScript 项目无法识别 WebGPU 类型，可以将它作为开发依赖安装：

    ```bash
    npm install -D @webgpu/types
    ```

## 三、引入 Web Worker

模型下载、权重初始化和文本生成都比较耗时。如果把这些工作放在主线程，页面交互容易卡顿。因此项目把推理逻辑放进 `src/worker.js`：

1. React 主线程创建 Worker，并发送 `check`、`load`、`generate`、`interrupt` 和 `reset` 消息。
2. Worker 在后台检测 WebGPU、下载模型、预热模型并执行生成。
3. Worker 通过 `postMessage` 返回加载进度、流式文本、生成速度和完成状态。
4. React 根据状态消息更新进度条、聊天消息和停止按钮。

这样可以把模型计算和页面渲染分离，主线程只负责交互与展示。

## 四、WebGPU 类型与类型断言

`navigator.gpu` 是较新的 WebGPU API，部分 TypeScript 配置或旧版本类型声明可能无法识别它。直接访问时可能出现类型错误：

```ts
navigator.gpu
```

一种临时写法是类型断言：

```ts
(navigator as any).gpu
```

`as` 只是在编译阶段告诉 TypeScript 如何理解这个值，`any` 会关闭这一处的类型检查，不能在项目中随意扩散。更稳妥的方式是补充 WebGPU 类型声明，例如安装 `@webgpu/types` 并在 `tsconfig.app.json` 中配置对应类型。

## 五、设计模式：单例模式

面向对象编程中常见的设计模式，是针对特定问题总结出的可复用设计方案。单例模式的核心是：一个类只允许创建一个实例，并为全局访问这个实例提供统一入口。

它可以避免重复创建全局资源，也可以集中管理全局状态。项目中的模型和分词器都属于开销较大的资源，因此使用单例方式延迟加载：

```js
class TextGenerationPipeline {
  static model_id = "onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX";

  static async getInstance(progress_callback = null) {
    this.tokenizer ??= AutoTokenizer.from_pretrained(this.model_id, {
      progress_callback,
    });
    this.model ??= AutoModelForCausalLM.from_pretrained(this.model_id, {
      dtype: "q4f16",
      device: "webgpu",
      progress_callback,
    });
    return Promise.all([this.tokenizer, this.model]);
  }
}
```

这里的 `??=` 是空值合并赋值运算符：只有变量为 `null` 或 `undefined` 时才会赋值。如果变量已经是有效对象或 Promise，就会保留原值。这样即使多个调用在首次下载完成前同时进入，也会等待同一组加载任务，不会重复下载模型或创建重复实例。

## 六、加载模型和分词器

`AutoTokenizer.from_pretrained` 和 `AutoModelForCausalLM.from_pretrained` 都是异步操作：模型文件较大，浏览器会分块下载。Transformers.js 通过 `progress_callback` 报告每个文件的开始、进度和完成事件，Worker 将这些事件转发给 React，页面据此绘制下载进度。

加载完成后，项目会用一个很短的输入执行一次生成，提前触发 WebGPU 着色器编译和算子初始化。这样用户第一次真正提问时，不需要同时承担模型下载、着色器编译和推理的全部等待时间。

## 七、运行项目

```bash
npm install
npm run dev
```

开发服务器启动后，打开终端输出的本地地址即可访问。运行环境需要浏览器支持 WebGPU；如果浏览器没有可用的 WebGPU 适配器，页面会显示不支持提示。
