import {
  AutoTokenizer,// 分词器
  AutoModelForCausalLM,// 模型
  TextStreamer,// 文本流式输出
  InterruptableStoppingCriteria, // 可中断的停止条件：模型每生成一个 token 前检查中断标记，用户点「停止」时触发中断
} from "@huggingface/transformers";

/**
 * 辅助函数：检测浏览器是否支持 WebGPU
 */
// let fp16_supported = false;
async function check() {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("WebGPU is not supported (no adapter found)");
    }
    // fp16_supported = adapter.features.has("shader-f16")
  } catch (e) {
    self.postMessage({
      status: "error",
      data: e.toString(),
    });
  }
}

/**
 * 单例模式：懒加载文本生成管道（tokenizer + model）
 * 避免重复加载模型，节省内存和时间
 */
class TextGenerationPipeline {
  static model_id = "onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX";

  static async getInstance(progress_callback = null) {
    // ??= 空值赋值：首次调用时初始化，后续复用
    // AutoTokenizer 根据 model_id 自动选择对应分词器配置
    // tokenizer model 等需要异步的下载并执行
    this.tokenizer ??= AutoTokenizer.from_pretrained(this.model_id, {
      // 下载进度回调函数
      progress_callback,
    });

    this.model ??= AutoModelForCausalLM.from_pretrained(this.model_id, {
      dtype: "q4f16",       // 4 比特量化 + fp16，减小模型体积
      device: "webgpu",     // 使用 WebGPU 加速推理
      progress_callback,
    });

    return Promise.all([this.tokenizer, this.model]);
  }
}

// 可中断的停止条件（用于用户点「停止」时打断生成）
const stopping_criteria = new InterruptableStoppingCriteria();

async function generate(messages) {
  // 获取文本生成管道（tokenizer + model）
  const [tokenizer, model] = await TextGenerationPipeline.getInstance();

  // 应用聊天模板，把 messages 数组转成模型输入
  // llm 的模版，deepseek/qwen 训练时使用的模版
  // <|im_start|>user
  // content<|im_end|>   字符串
  const inputs = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,  // 加上助手角色的开头标记 <|im_start|>assistant\n
    return_dict: true,// 返回字典格式（含 input_ids 和 attention_mask），可直接展开传给 model.generate
    // {
    //   input_ids: tensor([151649, 151650, ...]),  <- token id 序列
    //   attention_mask: tensor([1, 1, 1, ...]),  <- 注意力掩码，用于忽略 padding token
    // }
  });

  // 生成是两部分
  // 思考推理部分 + 模型生成部分
  const [, END_THINKING_TOKEN_ID] = tokenizer.encode(
      "<think></think>",
      { add_special_tokens: false },
  );

  let state = "thinking"; // 当前状态：thinking(思考中) 或 answering(回答中)
  let startTime;// 开始时间
  let numTokens = 0;// 处理的token总数
  let tps;// 每秒生成token数
  // 每生成一个 token 的回调：统计 token 数和 TPS（每秒生成 token 数）
  const token_callback_function = (tokens) => {
    startTime ??= performance.now();

    if (numTokens++ > 0) {
      tps = (numTokens / (performance.now() - startTime)) * 1000;
    }
    // 遇到思考结束标记，从思考阶段切换到回答阶段
    if (tokens[0] == END_THINKING_TOKEN_ID) {
      state = "answering";
    }
  };
  // 每段文本输出的回调：实时推送给主线程显示
  const callback_function = (output) => {
    self.postMessage({
      status: "update",
      output,
      tps,
      numTokens,
      state,
    });
  };

  // 文本流式输出器：边生成边输出，不用等全部完成
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,              // 不重复输出输入的 prompt
    skip_special_tokens: true,      // 跳过特殊 token（如 think 标签）
    callback_function,
    token_callback_function,
  });

  // 通知主线程：开始生成
  self.postMessage({ status: "start" });

  // sequences 是模型生成的 token 序列，需要解码成文本才能显示。
  // 当前每轮都基于完整 messages 重新计算；跨轮 KV Cache 需要额外验证输入形状和生命周期，暂不启用。
  const { sequences } = await model.generate({
    ...inputs,
    // TODO: 修复后启用 KV Cache 复用
    // past_key_values: past_key_values_cache,

    // 采样参数
    do_sample: false,           // 贪心解码：每步选概率最高的 token
    // repetition_penalty: 1.1, // 重复惩罚
    // top_k: 3,                 // Top-K 采样
    // temperature: 0.2,         // 温度（越低越确定）

    max_new_tokens: 2048,       // 最多生成 2048 个新 token
    streamer,                   // 流式输出器：边生成边输出，不用等全部完成
    stopping_criteria,          // 可中断的停止条件
    return_dict_in_generate: true,
  });
  // 把完整的 token 序列解码成文本
  const decoded = tokenizer.batch_decode(sequences, {
    skip_special_tokens: true,
  });

  // 通知主线程：生成完成，返回最终结果
  self.postMessage({
    status: "complete",
    output: decoded,
  });
}

async function load() {
  self.postMessage({
    status: "loading",
    data: "Loading model...",
  });

  // 加载管道（tokenizer + model），并保存供后续使用
  const [tokenizer, model] = await TextGenerationPipeline.getInstance((x) => {
    // 进度回调：把模型下载进度转发给主线程显示
    self.postMessage(x);
  });

  self.postMessage({
    status: "loading",
    data: "Compiling shaders and warming up model...",// 编译 shader 并预热模型
  });

  // 用假输入跑一次模型，提前编译 shader（预热，避免首次推理卡顿）
  const inputs = tokenizer("a");
  await model.generate({ ...inputs, max_new_tokens: 1 });
  self.postMessage({ status: "ready" });
}

// 监听主线程发来的消息
self.addEventListener("message", async (e) => {
  const { type, data } = e.data;

  switch (type) {
    case "check":
      // 检测 WebGPU 支持
      check();
      break;

    case "load":
      // 加载模型
      load();
      break;

    case "generate":
      // 生成文本（先重置停止条件）
      stopping_criteria.reset();
      generate(data);
      break;

    case "interrupt":
      // 中断生成
      // interrupted 设置为true，llm 实例的属性 每次生成token 检测
      stopping_criteria.interrupt();
      break;

    case "reset":
      // 重置停止条件；会话上下文由主线程清空后重新传入。
      stopping_criteria.reset();
      break;
  }
});
