import { useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import PropTypes from "prop-types";

import BotIcon from "./icons/BotIcon";
import BrainIcon from "./icons/BrainIcon";
import UserIcon from "./icons/UserIcon";

import { MathJaxContext, MathJax } from "better-react-mathjax";
import "./Chat.css";

function render(text) {
  // marked 会吞掉数学公式定界符前的单个反斜杠，因此在解析 Markdown 前先将
  // \[、\]、\(、\) 转义为双反斜杠，确保 MathJax 最终仍能识别这些定界符。
  // 兼容性问题的背景见：https://github.com/markedjs/marked/issues/546
  text = text.replace(/\\([[\]()])/g, "\\\\$1");

  // 模型输出属于不可信内容：先转换为 HTML，再用 DOMPurify 清洗，最后才交给
  // dangerouslySetInnerHTML 渲染，以阻止脚本标签和危险属性进入页面。
  const result = DOMPurify.sanitize(
    marked.parse(text, {
      async: false,
      breaks: true,
    }),
  );
  return result;
}
function Message({ role, content, answerIndex }) {
  // worker 在检测到 </think> 时记录 answerIndex。索引之前是推理过程，之后是最终回答；
  // 尚未检测到结束标记时，整段流式内容都暂时归入推理过程。
  const hasAnswer = answerIndex !== undefined;
  const thinking = hasAnswer ? content.slice(0, answerIndex) : content;
  const answer = hasAnswer ? content.slice(answerIndex) : "";

  const [showThinking, setShowThinking] = useState(false);

  // 最终回答出现内容后，推理折叠区由“生成中”切换为可展开查看的完成状态。
  const doneThinking = answer.length > 0;

  return (
    <div className="flex items-start space-x-4">
      {role === "assistant" ? (
        <>
          <BotIcon className="h-6 w-6 min-h-6 min-w-6 my-3 text-gray-500 dark:text-gray-300" />
          <div className="bg-gray-200 dark:bg-gray-700 rounded-lg p-4">
            <div className="min-h-6 text-gray-800 dark:text-gray-200 overflow-wrap-anywhere">
              {thinking.length > 0 ? (
                <>
                  <div className="bg-white dark:bg-gray-800 rounded-lg flex flex-col">
                    <button
                      className="flex items-center gap-2 cursor-pointer p-4 hover:bg-gray-50 dark:hover:bg-gray-900 rounded-lg "
                      onClick={() => setShowThinking((prev) => !prev)}
                      style={{ width: showThinking ? "100%" : "auto" }}
                    >
                      <BrainIcon
                        className={doneThinking ? "" : "animate-pulse"}
                      />
                      <span>
                        {doneThinking ? "View reasoning." : "Thinking..."}
                      </span>
                      <span className="ml-auto text-gray-700">
                        {showThinking ? "▲" : "▼"}
                      </span>
                    </button>
                    {showThinking && (
                      <MathJax
                        className="border-t border-gray-200 dark:border-gray-700 px-4 py-2"
                        dynamic
                      >
                        <span
                          className="markdown"
                          dangerouslySetInnerHTML={{
                            __html: render(thinking),
                          }}
                        />
                      </MathJax>
                    )}
                  </div>
                  {doneThinking && (
                    <MathJax className="mt-2" dynamic>
                      <span
                        className="markdown"
                        dangerouslySetInnerHTML={{
                          __html: render(answer),
                        }}
                      />
                    </MathJax>
                  )}
                </>
              ) : (
                <span className="h-6 flex items-center gap-1">
                  <span className="w-2.5 h-2.5 bg-gray-600 dark:bg-gray-300 rounded-full animate-pulse"></span>
                  <span className="w-2.5 h-2.5 bg-gray-600 dark:bg-gray-300 rounded-full animate-pulse animation-delay-200"></span>
                  <span className="w-2.5 h-2.5 bg-gray-600 dark:bg-gray-300 rounded-full animate-pulse animation-delay-400"></span>
                </span>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          <UserIcon className="h-6 w-6 min-h-6 min-w-6 my-3 text-gray-500 dark:text-gray-300" />
          <div className="bg-blue-500 text-white rounded-lg p-4">
            <p className="min-h-6 overflow-wrap-anywhere">{content}</p>
          </div>
        </>
      )}
    </div>
  );
}

Message.propTypes = {
  role: PropTypes.oneOf(["user", "assistant"]).isRequired,
  content: PropTypes.string.isRequired,
  answerIndex: PropTypes.number,
};

export default function Chat({ messages }) {
  const empty = messages.length === 0;

  return (
    <div
      className={`flex-1 p-6 max-w-[960px] w-full ${empty ? "flex flex-col items-center justify-end" : "space-y-4"}`}
    >
      <MathJaxContext>
        {empty ? (
          <div className="text-xl">Ready!</div>
        ) : (
          messages.map((msg, i) => <Message key={`message-${i}`} {...msg} />)
        )}
      </MathJaxContext>
    </div>
  );
}

Chat.propTypes = {
  messages: PropTypes.arrayOf(
    PropTypes.shape({
      role: PropTypes.oneOf(["user", "assistant"]).isRequired,
      content: PropTypes.string.isRequired,
      answerIndex: PropTypes.number,
    }),
  ).isRequired,
};
