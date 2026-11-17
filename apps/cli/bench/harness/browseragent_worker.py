import asyncio
import json
import os
import sys
import time
from pathlib import Path


def plain(content):
    if isinstance(content, str):
        return content
    if isinstance(content, (list, tuple)):
        return "\n".join(plain(part) for part in content)
    if hasattr(content, "data") and hasattr(content, "media_type"):
        return f"[{content.media_type} shown to the agent]"
    try:
        return json.dumps(content, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(content)


def steps_from(messages):
    out, calls = [], {}
    for message in messages:
        for part in message.parts:
            kind = type(part).__name__
            if kind == "TextPart" and part.content.strip():
                out.append({"kind": "text", "text": part.content.strip()[:4000]})
            elif kind == "ToolCallPart":
                calls[part.tool_call_id] = part
            elif kind in ("ToolReturnPart", "RetryPromptPart") and getattr(part, "tool_call_id", None) in calls:
                call = calls.pop(part.tool_call_id)
                args = call.args_as_dict() if hasattr(call, "args_as_dict") else call.args
                code = args.get("code") if isinstance(args, dict) and call.tool_name == "python" else args
                out.append({"kind": "tool", "tool": call.tool_name, "input": plain(code)[:4000],
                            "output": plain(part.content)[:2000], "retry": kind == "RetryPromptPart",
                            "at": time.time()})
    return out


async def main():
    if len(sys.argv) != 8:
        raise SystemExit("usage: browseragent_worker.py PROMPT_FILE CDP_URL MODEL EFFORT TIMEOUT_S MAX_STEPS OUT_DIR")
    prompt_file, cdp_url, model_name, effort, timeout, max_steps, out_dir = sys.argv[1:8]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    import browser_use
    from browser_use import Agent, Browser
    from browser_use.agent.loop import reasoning_supported

    if model_name.startswith("claude"):
        from pydantic_ai.models.anthropic import AnthropicModel
        from pydantic_ai.providers.anthropic import AnthropicProvider

        llm = AnthropicModel(model_name, provider=AnthropicProvider(
            api_key=os.environ["OPENAI_API_KEY"], base_url=os.environ["OPENAI_BASE_URL"].removesuffix("/v1")),
            settings={"anthropic_cache_messages": False})
    else:
        from pydantic_ai.models.openai import OpenAIResponsesModel
        from pydantic_ai.providers.openai import OpenAIProvider

        llm = OpenAIResponsesModel(model_name, provider=OpenAIProvider(api_key=os.environ["OPENAI_API_KEY"],
                                                                       base_url=os.environ["OPENAI_BASE_URL"]))
    browser = Browser(cdp_url=cdp_url)
    agent = Agent(Path(prompt_file).read_text(), llm, browser=browser, reasoning=effort, workspace=out / "workspace",
                  judge=False)
    started = time.monotonic()
    result, error = None, None
    try:
        result = await agent.run(max_steps=int(max_steps), timeout=float(timeout))
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            await agent.close()
        except Exception:
            pass
    messages = list(result.messages) if result is not None else []
    steps = steps_from(messages)
    with (out / "steps.jsonl").open("w") as f:
        for step in steps:
            f.write(json.dumps(step, ensure_ascii=False) + "\n")
    metrics = {
        "status": result.status if result is not None else "error",
        "final_message": result.text if result is not None else None,
        "success": result.success if result is not None else None,
        "model_requests": result.steps if result is not None else None,
        "usage": dict(result.usage) if result is not None else {},
        "cost_usd": result.cost_usd if result is not None else None,
        "error": error or (result.error if result is not None else None),
        "python_cells": sum(1 for s in steps if s["kind"] == "tool" and s["tool"] == "python"),
        "tool_calls": sum(1 for s in steps if s["kind"] == "tool"),
        "duration_s": round(time.monotonic() - started, 3),
        "browser_use": getattr(browser_use, "__version__", None),
        "llm_class": type(llm).__name__,
        "reasoning_applied": reasoning_supported(llm),
    }
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2, default=str))


asyncio.run(main())
