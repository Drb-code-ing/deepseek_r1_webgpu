import {
  AutoTokenizer,
  AutoModelForCausalLM,
} from "@huggingface/transformers";

// 申请 WebGPU 适配器，确认浏览器和当前设备能够运行模型。
async function check() {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("WebGPU is not supported (no adapter found)");
    }
  } catch (e) {
    self.postMessage({
      status: "error",
      data: e.toString(),
    });
  }
}

/**
 * 以单例方式延迟加载分词器和模型。静态字段保存加载 Promise，因此并发调用也会
 * 等待同一组任务，不会重复下载权重或创建多个模型实例。
 */
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

async function load() {
  self.postMessage({
    status: "loading",
    data: "Loading model...",
  });

  const [tokenizer, model] = await TextGenerationPipeline.getInstance((event) => {
    self.postMessage(event);
  });

  self.postMessage({
    status: "loading",
    data: "Compiling shaders and warming up model...",
  });

  // 用最小输入预热模型，提前触发 WebGPU 着色器编译。
  const inputs = tokenizer("a");
  await model.generate({ ...inputs, max_new_tokens: 1 });
  self.postMessage({ status: "ready" });
}

self.addEventListener("message", async (event) => {
  const { type } = event.data;

  switch (type) {
    case "check":
      check();
      break;
    case "load":
      load();
      break;
  }
});
