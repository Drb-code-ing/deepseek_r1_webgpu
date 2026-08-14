import { useEffect, useState, useRef } from "react";

import Chat from "./components/Chat";
import ArrowRightIcon from "./components/icons/ArrowRightIcon";
import StopIcon from "./components/icons/StopIcon";
import Progress from "./components/Progress";

const IS_WEBGPU_AVAILABLE = !!navigator.gpu;
const STICKY_SCROLL_THRESHOLD = 120;
const EXAMPLES = [
  "Solve the equation x^2 - 3x + 2 = 0",
  "Lily is three times older than her son. In 15 years, she will be twice as old as him. How old is she now?",
  "Write python code to compute the nth fibonacci number.",
];

function App() {
  // 使用 ref 持有唯一的 Web Worker 实例。ref 的值跨渲染保持不变，更新时也不会
  // 触发组件重新渲染，适合保存负责模型加载和推理的后台线程对象。
  const worker = useRef(null);

  // textareaRef 用于根据内容调整输入框高度；chatContainerRef 用于控制聊天区滚动位置。
  const textareaRef = useRef(null);
  const chatContainerRef = useRef(null);

  // 模型生命周期状态：null 表示尚未加载，loading 表示正在下载或预热，ready 表示可推理。
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState("");
  // Transformers.js 会分别报告模型文件的下载事件，此数组用于同时展示多个文件的进度。
  const [progressItems, setProgressItems] = useState([]);
  const [isRunning, setIsRunning] = useState(false);

  // messages 保存发送给聊天模板的完整上下文；tps 和 numTokens 展示当前一轮的生成性能。
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [tps, setTps] = useState(null);
  const [numTokens, setNumTokens] = useState(null);

  function onEnter(message) {
    // 只追加用户消息；下面监听 messages 的副作用会把更新后的完整对话发送给 worker。
    // 同时清空上一轮速度并锁定输入区，直到收到 worker 的 complete 消息。
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setTps(null);
    setIsRunning(true);
    setInput("");
  }

  function onInterrupt() {
    // 此处只设置 worker 内部的停止标记，不提前修改 isRunning。生成循环确认中断后仍会
    // 发送 complete 消息，由统一的完成分支恢复界面，避免主线程与 worker 状态不一致。
    worker.current.postMessage({ type: "interrupt" });
  }

  // 输入内容变化后重新计算高度：先清除旧的内联高度以取得真实 scrollHeight，再将
  // 高度限制在 24 至 200 像素之间，兼顾单行输入和长文本编辑。
  useEffect(() => {
    if (!textareaRef.current) return;
    const target = textareaRef.current;
    target.style.height = "auto";
    const newHeight = Math.min(Math.max(target.scrollHeight, 24), 200);
    target.style.height = `${newHeight}px`;
  }, [input]);

  // 组件挂载时创建模块型 worker，并建立从后台线程到 React 状态的消息桥接。
  useEffect(() => {
    // 防御性检查确保同一个组件实例只创建一个 worker；模型仍会等用户点击加载后再下载。
    if (!worker.current) {
      worker.current = new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
      });
      // check 只申请 WebGPU 适配器做能力检测，不会在此时下载或初始化模型。
      worker.current.postMessage({ type: "check" });
    }

    // worker 以 status 字段区分生命周期事件、下载进度和流式生成内容。
    const onMessageReceived = (e) => {
      switch (e.data.status) {
        case "loading":
          // 模型下载或着色器预热进入新阶段，展示 worker 提供的阶段说明。
          setStatus("loading");
          setLoadingMessage(e.data.data);
          break;

        case "initiate":
          // 某个模型文件开始下载。函数式更新始终基于最新数组追加记录，可正确处理
          // 多文件并发下载时连续到达的 initiate 事件。
          setProgressItems((prev) => [...prev, e.data]);
          break;

        case "progress":
          // 通过文件名定位下载项，仅合并该文件最新的字节数和百分比等进度字段。
          setProgressItems((prev) =>
            prev.map((item) => {
              if (item.file === e.data.file) {
                return { ...item, ...e.data };
              }
              return item;
            }),
          );
          break;

        case "done":
          // 文件完成后移除对应进度条；其他仍在下载的文件继续保留。
          setProgressItems((prev) =>
            prev.filter((item) => item.file !== e.data.file),
          );
          break;

        case "ready":
          // 分词器、模型与 WebGPU 着色器均已准备完成，此后才允许用户提交消息。
          setStatus("ready");
          break;

        case "start":
          {
            // 为本轮回复追加空的 assistant 消息，后续 update 事件会持续向其末尾拼接文本。
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: "" },
            ]);
          }
          break;

        case "update":
          {
            // 同步性能指标，并将流式文本片段追加到最后一条 assistant 消息。
            const { output, tps, numTokens, state } = e.data;
            setTps(tps);
            setNumTokens(numTokens);
            setMessages((prev) => {
              const cloned = [...prev];
              const last = cloned.at(-1);
              const data = {
                ...last,
                content: last.content + output,
              };
              if (data.answerIndex === undefined && state === "answering") {
                // worker 识别到思考结束标记后会切换为 answering。首次进入该状态时记录
                // 当前文本长度，作为 UI 切分“推理过程”和“最终回答”的稳定边界。
                // 必须显式判断 undefined，因为合法边界索引可能为 0。
                data.answerIndex = last.content.length;
              }
              cloned[cloned.length - 1] = data;
              return cloned;
            });
          }
          break;

        case "complete":
          // 正常结束或响应中断后都会进入此分支，恢复发送按钮并停止生成态动画。
          setIsRunning(false);
          break;

        case "error":
          // 能力检测或模型初始化失败时保留错误文本，供加载页向用户展示。
          setError(e.data.data);
          break;
      }
    };

    const onErrorReceived = (e) => {
      // error 事件表示 worker 脚本自身发生未捕获异常，与协议中的 status="error" 不同。
      console.error("Worker error:", e);
    };

    // 同时监听业务消息和 worker 运行时异常。
    worker.current.addEventListener("message", onMessageReceived);
    worker.current.addEventListener("error", onErrorReceived);

    // 卸载时解除当前组件注册的监听器，避免重复处理事件或保留无效闭包。
    return () => {
      worker.current.removeEventListener("message", onMessageReceived);
      worker.current.removeEventListener("error", onErrorReceived);
    };
  }, []);

  // 仅当末尾新增用户消息时触发一次生成；assistant 的流式更新也会改变 messages，
  // 因而必须通过最后一条消息的角色阻止递归生成。
  useEffect(() => {
    if (messages.filter((x) => x.role === "user").length === 0) {
      // 初始空会话不应触发推理。
      return;
    }
    if (messages.at(-1).role === "assistant") {
      // 最后一条来自 assistant，说明这是流式回复更新或已完成的对话，不重复提交。
      return;
    }
    // 发送完整上下文，让 worker 中的 tokenizer 按模型聊天模板统一编码。
    worker.current.postMessage({ type: "generate", data: messages });
  }, [messages, isRunning]);

  // 生成期间仅在用户仍靠近底部时自动跟随新内容。若用户向上滚动超过阈值，保留其
  // 阅读位置，避免每个流式文本片段都强制将页面拉回底部。
  useEffect(() => {
    if (!chatContainerRef.current || !isRunning) return;
    const element = chatContainerRef.current;
    if (
      element.scrollHeight - element.scrollTop - element.clientHeight <
      STICKY_SCROLL_THRESHOLD
    ) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, isRunning]);

  return IS_WEBGPU_AVAILABLE ? (
    <div className="flex flex-col h-screen mx-auto items justify-end text-gray-800 dark:text-gray-200 bg-white dark:bg-gray-900">
      {status === null && messages.length === 0 && (
        <div className="h-full overflow-auto scrollbar-thin flex justify-center items-center flex-col relative">
          <div className="flex flex-col items-center mb-1 max-w-[400px] text-center">
            <img
              src="logo.png"
              width="80%"
              height="auto"
              className="block drop-shadow-lg bg-transparent"
            ></img>
            <h1 className="text-4xl font-bold mb-1">DeepSeek-R1 WebGPU</h1>
            <h2 className="font-semibold">
              A next-generation reasoning model that runs locally in your
              browser with WebGPU acceleration.
            </h2>
          </div>

          <div className="flex flex-col items-center px-4">
            <p className="max-w-[510px] mb-4">
              <br />
              You are about to load{" "}
              <a
                href="https://huggingface.co/onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX"
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
              >
                DeepSeek-R1-Distill-Qwen-1.5B
              </a>
              , a 1.5B parameter reasoning LLM optimized for in-browser
              inference. Everything runs entirely in your browser with{" "}
              <a
                href="https://huggingface.co/docs/transformers.js"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                🤗&nbsp;Transformers.js
              </a>{" "}
              and ONNX Runtime Web, meaning no data is sent to a server. Once
              loaded, it can even be used offline. The source code for the demo
              is available on{" "}
              <a
                href="https://github.com/huggingface/transformers.js-examples/tree/main/deepseek-r1-webgpu"
                target="_blank"
                rel="noreferrer"
                className="font-medium underline"
              >
                GitHub
              </a>
              .
            </p>

            {error && (
              <div className="text-red-500 text-center mb-2">
                <p className="mb-1">
                  Unable to load model due to the following error:
                </p>
                <p className="text-sm">{error}</p>
              </div>
            )}

            <button
              className="border px-4 py-2 rounded-lg bg-blue-400 text-white hover:bg-blue-500 disabled:bg-blue-100 cursor-pointer disabled:cursor-not-allowed select-none"
              onClick={() => {
                worker.current.postMessage({ type: "load" });
                setStatus("loading");
              }}
              disabled={status !== null || error !== null}
            >
              Load model
            </button>
          </div>
        </div>
      )}
      {status === "loading" && (
        <>
          <div className="w-full max-w-[500px] text-left mx-auto p-4 bottom-0 mt-auto">
            <p className="text-center mb-1">{loadingMessage}</p>
            {progressItems.map(({ file, progress, total }, i) => (
              <Progress
                key={i}
                text={file}
                percentage={progress}
                total={total}
              />
            ))}
          </div>
        </>
      )}

      {status === "ready" && (
        <div
          ref={chatContainerRef}
          className="overflow-y-auto scrollbar-thin w-full flex flex-col items-center h-full"
        >
          <Chat messages={messages} />
          {messages.length === 0 && (
            <div>
              {EXAMPLES.map((msg, i) => (
                <div
                  key={i}
                  className="m-1 border border-gray-300 dark:border-gray-600 rounded-md p-2 bg-gray-100 dark:bg-gray-700 cursor-pointer"
                  onClick={() => onEnter(msg)}
                >
                  {msg}
                </div>
              ))}
            </div>
          )}
          <p className="text-center text-sm min-h-6 text-gray-500 dark:text-gray-300">
            {tps && messages.length > 0 && (
              <>
                {!isRunning && (
                  <span>
                    Generated {numTokens} tokens in{" "}
                    {(numTokens / tps).toFixed(2)} seconds&nbsp;&#40;
                  </span>
                )}
                {
                  <>
                    <span className="font-medium text-center mr-1 text-black dark:text-white">
                      {tps.toFixed(2)}
                    </span>
                    <span className="text-gray-500 dark:text-gray-300">
                      tokens/second
                    </span>
                  </>
                }
                {!isRunning && (
                  <>
                    <span className="mr-1">&#41;.</span>
                    <span
                      className="underline cursor-pointer"
                      onClick={() => {
                        worker.current.postMessage({ type: "reset" });
                        setMessages([]);
                      }}
                    >
                      Reset
                    </span>
                  </>
                )}
              </>
            )}
          </p>
        </div>
      )}

      <div className="mt-2 border border-gray-300 dark:bg-gray-700 rounded-lg w-[600px] max-w-[80%] max-h-[200px] mx-auto relative mb-3 flex">
        <textarea
          ref={textareaRef}
          className="scrollbar-thin w-[550px] dark:bg-gray-700 px-3 py-4 rounded-lg bg-transparent border-none outline-hidden text-gray-800 disabled:text-gray-400 dark:text-gray-200 placeholder-gray-500 dark:placeholder-gray-400 disabled:placeholder-gray-200 resize-none disabled:cursor-not-allowed"
          placeholder="Type your message..."
          rows={1}
          value={input}
          disabled={status !== "ready"}
          title={status === "ready" ? "Model is ready" : "Model not loaded yet"}
          onKeyDown={(e) => {
            if (
              input.length > 0 &&
              !isRunning &&
              e.key === "Enter" &&
              !e.shiftKey
            ) {
              // 单独按 Enter 时阻止 textarea 换行并发送；Shift+Enter 仍保留换行行为。
              e.preventDefault();
              onEnter(input);
            }
          }}
          onInput={(e) => setInput(e.target.value)}
        />
        {isRunning ? (
          <div className="cursor-pointer" onClick={onInterrupt}>
            <StopIcon className="h-8 w-8 p-1 rounded-md text-gray-800 dark:text-gray-100 absolute right-3 bottom-3" />
          </div>
        ) : input.length > 0 ? (
          <div className="cursor-pointer" onClick={() => onEnter(input)}>
            <ArrowRightIcon
              className={`h-8 w-8 p-1 bg-gray-800 dark:bg-gray-100 text-white dark:text-black rounded-md absolute right-3 bottom-3`}
            />
          </div>
        ) : (
          <div>
            <ArrowRightIcon
              className={`h-8 w-8 p-1 bg-gray-200 dark:bg-gray-600 text-gray-50 dark:text-gray-800 rounded-md absolute right-3 bottom-3`}
            />
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 text-center mb-3">
        Disclaimer: Generated content may be inaccurate or false.
      </p>
    </div>
  ) : (
    <div className="fixed w-screen h-screen bg-black z-10 bg-opacity-[92%] text-white text-2xl font-semibold flex justify-center items-center text-center">
      WebGPU is not supported
      <br />
      by this browser :&#40;
    </div>
  );
}

export default App;
