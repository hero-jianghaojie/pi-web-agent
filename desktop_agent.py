#!/usr/bin/env python3
"""
desktop_agent.py — 拟人化桌面 GUI 识别/操作系统

核心升级（相比旧版）：
  1. per-monitor DPI 感知 —— 修好混合 DPI 双屏的坐标错位
  2. 截全屏（all_screens）—— 副屏上的窗口也能看见
  3. UIA 枚举控件 + Set-of-Mark 编号框 —— 模型选「编号」而不是猜像素坐标
  4. 进程检测 / 重复动作检测 / 每步只发当前截图 / 失败清理

依赖：pyautogui, Pillow, requests, uiautomation
用法：
  set TOKENDANCE_API_KEY=sk-xxxx
  python desktop_agent.py --task "打开记事本" --max-steps 12
  python desktop_agent.py --task "..." --dry-run           # 只看决策
  python desktop_agent.py --task "..." --no-marks          # 关闭 UIA 编号框
"""

# ---- DPI 感知必须在导入 pyautogui / PIL 之前设置 ----
import ctypes
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

import argparse
import base64
import io
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    import requests
except ImportError:
    sys.exit("缺少 requests：python -m pip install requests")

try:
    import pyautogui
    from PIL import Image, ImageDraw, ImageFont, ImageGrab
except ImportError as e:
    sys.exit(f"缺少依赖：{e}\n请先运行：python -m pip install pyautogui pillow")

try:
    import uiautomation as auto
    UIA_OK = True
except Exception:
    UIA_OK = False


DEFAULT_BASE = "https://tokendance.space/gateway/v1/chat/completions"
DEFAULT_MODEL = "qwen3-vl-plus"
MAX_IMAGE_WIDTH = 1280      # 截图缩到最大宽度（越小越快）
MAX_MARKS = 25              # 最多标注多少个控件（太多会让模型编号混乱、也变慢）

# UIA 里“可点击/可交互”的控件类型
INTERACTIVE_TYPES = {
    "ButtonControl", "EditControl", "MenuItemControl", "ListItemControl",
    "HyperlinkControl", "TabItemControl", "CheckBoxControl", "RadioButtonControl",
    "ComboBoxControl", "TreeItemControl", "SplitButtonControl", "SpinnerControl",
    "SliderControl", "TextControl", "DataItemControl", "HeaderItemControl",
    "MenuBarControl", "ToolBarControl", "ThumbControl",
}

_NOISE_PROCS = {
    "conhost", "cmd", "powershell", "pwsh", "windowsterminal", "dllhost",
    "runtimebroker", "svchost", "taskhostw", "sihost", "ctfmon", "searchhost",
    "shellexperiencehost", "startmenuexperiencehost", "textinputhost", "fontdrvhost",
}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def virtual_screen():
    u = ctypes.windll.user32
    return (u.GetSystemMetrics(76), u.GetSystemMetrics(77),
            u.GetSystemMetrics(78), u.GetSystemMetrics(79))


VX, VY, VCX, VCY = virtual_screen()


def get_process_names() -> set:
    try:
        out = subprocess.run(["tasklist", "/fo", "csv", "/nh"],
                             capture_output=True, text=True, timeout=20).stdout
        names = set()
        for line in out.splitlines():
            m = re.match(r'"([^"]+)"', line)
            if m:
                names.add(m.group(1).lower().replace(".exe", ""))
        return names
    except Exception:
        return set()


def screen_signature(img) -> list:
    return list(img.convert("L").resize((64, 64)).getdata())


def diff_ratio(a, b) -> float:
    if a is None or b is None:
        return 1.0
    return sum(abs(x - y) for x, y in zip(a, b)) / (255 * len(a))


def take_screenshot(max_width: int = MAX_IMAGE_WIDTH):
    """截整个虚拟屏（含副屏），缩到 max_width，返回 (b64, scale, w, h, sig)。"""
    try:
        img = ImageGrab.grab(all_screens=True)
    except TypeError:
        img = ImageGrab.grab()
    ow, oh = img.size
    scale = 1.0
    if ow > max_width:
        scale = max_width / ow
        img = img.resize((int(ow * scale), int(oh * scale)), Image.LANCZOS)
    sig = screen_signature(img)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii"), scale, img.size[0], img.size[1], sig


def get_ui_elements(max_elements: int = MAX_MARKS):
    """用 UIA 枚举可交互控件，返回 [{name,type,rect}]（屏幕物理坐标）。"""
    if not UIA_OK:
        return []
    elements = []
    seen = set()

    def walk(ctrl, depth=0):
        if depth > 12 or len(elements) >= max_elements:
            return
        try:
            children = ctrl.GetChildren()
        except Exception:
            return
        for ch in children:
            if len(elements) >= max_elements:
                return
            try:
                name = (ch.Name or "").strip()
                ctype = ch.ControlTypeName or ""
                rect = ch.BoundingRectangle
                w = rect.right - rect.left
                h = rect.bottom - rect.top
                if (name and ctype in INTERACTIVE_TYPES
                        and 4 < w < 6000 and 4 < h < 4000):
                    key = (name[:30], rect.left, rect.top)
                    if key not in seen:
                        seen.add(key)
                        elements.append({
                            "name": name[:40], "type": ctype,
                            "rect": (rect.left, rect.top, rect.right, rect.bottom),
                        })
            except Exception:
                pass
            walk(ch, depth + 1)

    try:
        root = auto.GetRootControl()
        walk(root)
    except Exception:
        pass
    # 按位置排序（上到下、左到右），编号更稳定直观
    elements.sort(key=lambda e: (e["rect"][1], e["rect"][0]))
    return elements


def annotate_marks(img, elements, scale):
    """在截图上给每个 UIA 控件画编号红框（Set-of-Mark）。"""
    draw = ImageDraw.Draw(img)
    font = None
    for fp in (r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\segoeuib.ttf"):
        try:
            font = ImageFont.truetype(fp, 15)
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()

    for i, el in enumerate(elements):
        l, t, r, b = el["rect"]
        x0 = (l - VX) * scale
        y0 = (t - VY) * scale
        x1 = (r - VX) * scale
        y1 = (b - VY) * scale
        draw.rectangle([x0, y0, x1, y1], outline=(255, 64, 64), width=2)
        label = str(i + 1)
        draw.rectangle([x0, y0, x0 + 20, y0 + 18], fill=(255, 64, 64))
        draw.text((x0 + 4, y0 + 1), label, fill=(255, 255, 255), font=font)
    return img


SYSTEM_PROMPT = """You are a desktop automation agent controlling a real Windows computer (possibly multiple monitors).
You receive a screenshot of the whole desktop. Red numbered boxes ("marks") are drawn over real UI controls detected via Windows UI Automation. The list of marks (number -> control name/type) is given in the user message.

Decide the SINGLE next action. Respond with ONLY a JSON object (no markdown fences):

{
  "thought": "one short sentence",
  "action": "click" | "double_click" | "right_click" | "type" | "key" | "scroll" | "wait" | "done" | "fail",
  "mark": <int>,                 // PREFERRED for click/double_click/right_click: the red mark number to click
  "x": <int>, "y": <int>,        // fallback ONLY if no mark fits; separate integers in screenshot pixels
  "text": "<string>",            // for type
  "keys": "<string>",            // for key, e.g. "enter", "win+r", "ctrl+s"
  "amount": <int>,               // for scroll (negative = down)
  "seconds": <number>,           // for wait
  "summary": "<string>"          // for done/fail
}

Rules:
- Keep "thought" to <= 12 words. Be decisive; do NOT over-analyze or write long reasoning.
- STRONGLY prefer clicking by "mark" (the numbered control). Only use raw x/y when no mark matches.
- The marks are RE-NUMBERED every step from the CURRENT screenshot. Always pick from the current mark list; never reuse a number you saw in an earlier step.
- For Calculator / numeric entry, prefer the keyboard: focus the app, then use "type" (e.g. type "123*12") and press Enter or type "=". Typing is far more reliable than clicking tiny buttons.
- Exactly ONE action per step.
- The desktop may use a CUSTOM shell, so the Windows key may NOT open the standard Start menu. To launch an app, prefer Win+R then type the executable name and press Enter.
- If an app you launched does not appear, it may already be open behind other windows — use Alt+Tab, do NOT relaunch repeatedly.
- Never repeat the same action more than twice; change strategy instead.
- If the target app is listed among newly started processes, it is already open — switch to it or use action "done".
- When the task is complete, use action "done" with a summary."""


def call_model(base, model, api_key, messages, timeout=120):
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "messages": messages, "temperature": 0, "max_tokens": 300}
    resp = requests.post(base, headers=headers, json=payload, timeout=timeout)
    if resp.status_code != 200:
        raise RuntimeError(f"API {resp.status_code}: {resp.text[:300]}")
    return resp.json()["choices"][0]["message"]["content"]


def call_model_retry(base, model, api_key, messages, retries=3):
    err = "empty response"
    for attempt in range(1, retries + 1):
        try:
            content = call_model(base, model, api_key, messages)
            if content and content.strip():
                return content
            err = "empty response"
        except Exception as e:  # noqa: BLE001
            err = str(e)
        if attempt < retries:
            time.sleep(1.5 * attempt)
    raise RuntimeError(f"模型多次调用失败: {err}")


def parse_action(text: str):
    if not text:
        return None
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    m = re.search(r"\{[\s\S]*\}", t)
    if not m:
        return None
    raw = m.group(0)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    action = {}
    am = re.search(r'"action"\s*:\s*"([^"]+)"', raw)
    if not am:
        return None
    action["action"] = am.group(1)
    tm = re.search(r'"thought"\s*:\s*"(.*?)"\s*,\s*"', raw, re.S)
    if tm:
        action["thought"] = tm.group(1)
    for key in ("text", "keys", "summary"):
        km = re.search(rf'"{key}"\s*:\s*"(.*?)"\s*(?:,|\}})', raw, re.S)
        if km:
            action[key] = km.group(1)
    for key in ("x", "y", "mark", "amount"):
        km = re.search(rf'"{key}"\s*:\s*(-?\d+)', raw)
        if km:
            action[key] = int(km.group(1))
    sm = re.search(r'"seconds"\s*:\s*(-?[\d.]+)', raw)
    if sm:
        action["seconds"] = float(sm.group(1))
    return action


def action_signature(action: dict) -> str:
    act = (action.get("action") or "").lower()
    if act in ("click", "double_click", "right_click"):
        return f"{act}#{action.get('mark') if action.get('mark') is not None else (action.get('x'), action.get('y'))}"
    if act == "type":
        return f"type:{action.get('text','')}"
    if act == "key":
        return f"key:{action.get('keys','')}"
    if act == "scroll":
        return f"scroll:{action.get('amount')}"
    return act


def cleanup_dialogs(dry_run: bool, times: int = 2):
    if dry_run:
        return
    for _ in range(times):
        try:
            pyautogui.press("esc")
        except Exception:
            pass
        time.sleep(0.3)


def do_type(text: str):
    if all(ord(c) < 128 for c in text):
        pyautogui.write(text, interval=0.02)
    else:
        import pyperclip
        pyperclip.copy(text)
        pyautogui.hotkey("ctrl", "v")


def execute(action: dict, scale: float, elements: list, dry_run: bool):
    act = (action.get("action") or "").lower()

    def num(v, default=0):
        if isinstance(v, (list, tuple)):
            v = v[0] if v else default
        try:
            return float(v)
        except (TypeError, ValueError):
            return float(default)

    def target_point():
        """优先用 mark（UIA 控件中心），否则用 x/y（截图坐标 -> 屏幕坐标）。"""
        mark = action.get("mark")
        if mark is not None:
            try:
                idx = int(mark) - 1
                if 0 <= idx < len(elements):
                    l, t, r, b = elements[idx]["rect"]
                    return int((l + r) / 2), int((t + b) / 2)
            except Exception:
                pass
        xv, yv = action.get("x", 0), action.get("y", 0)
        if isinstance(xv, (list, tuple)) and len(xv) >= 2:
            xv, yv = xv[0], xv[1]
        return int(VX + num(xv) / scale), int(VY + num(yv) / scale)

    desc = json.dumps({k: v for k, v in action.items() if k != "thought"}, ensure_ascii=False)
    log(f"  动作: {act}  {desc}")

    if act in ("done", "fail"):
        return act
    if dry_run:
        return "continue"

    if act == "click":
        pyautogui.click(*target_point())
    elif act == "double_click":
        pyautogui.doubleClick(*target_point())
    elif act == "right_click":
        pyautogui.rightClick(*target_point())
    elif act == "type":
        do_type(action.get("text", ""))
    elif act == "key":
        keys = [k.strip() for k in re.split(r"[+,]", action.get("keys", "")) if k.strip()]
        if len(keys) > 1:
            pyautogui.hotkey(*keys)
        elif keys:
            pyautogui.press(keys[0])
    elif act == "scroll":
        pyautogui.scroll(int(num(action.get("amount", -3), -3)))
    elif act == "wait":
        time.sleep(num(action.get("seconds", 1), 1))
    else:
        log(f"  (未知动作 {act!r}，跳过)")
    return "continue"


def run(task, base, model, api_key, max_steps, dry_run, delay, save_dir, cleanup, use_marks):
    log(f"任务: {task}")
    log(f"模型: {model}   {'(DRY-RUN，不执行动作)' if dry_run else ''}")
    log(f"虚拟屏: ({VX},{VY}) {VCX}x{VCY}   UIA={'开' if (UIA_OK and use_marks) else '关'}")

    history = []
    prev_sig = None
    no_change = 0
    last_sig = None
    repeat_count = 0
    initial_procs = get_process_names()

    for step in range(1, max_steps + 1):
        log(f"--- 第 {step}/{max_steps} 步：截图 ---")
        b64, scale, w, h, sig = take_screenshot()

        # UIA 控件 + 编号框
        elements = get_ui_elements() if (UIA_OK and use_marks) else []
        if elements:
            raw = base64.b64decode(b64)
            img = Image.open(io.BytesIO(raw))
            img = annotate_marks(img, elements, scale)
            buf = io.BytesIO(); img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        if save_dir:
            save_dir.mkdir(parents=True, exist_ok=True)
            (save_dir / f"step{step:02d}.png").write_bytes(base64.b64decode(b64))

        changed = diff_ratio(sig, prev_sig) > 0.002
        no_change = no_change + 1 if (step > 1 and not changed) else 0
        prev_sig = sig
        if no_change:
            log(f"  ⚠ 屏幕连续 {no_change} 次没有变化")

        hist_text = "\n".join(f"  第{i+1}步: {h}" for i, h in enumerate(history)) or "  (无)"
        hint = ""
        if no_change == 1:
            hint = "\n注意：上一次动作之后屏幕没有明显变化，请换一种方式。"
        elif no_change >= 2:
            hint = f"\n注意：已连续 {no_change} 次动作后屏幕无变化，请务必改变策略（优先点标记或键盘快捷键）。"
        if repeat_count >= 2:
            hint += f"\n严重警告：同一动作已重复 {repeat_count} 次，不要再用，换完全不同的做法；无法完成就用 action=\"fail\"。"

        new_procs = sorted((get_process_names() - initial_procs) - _NOISE_PROCS)
        proc_hint = ""
        if new_procs:
            proc_hint = (f"\n注意：本次运行期间新启动了这些进程：{', '.join(new_procs)}。"
                         "若目标任务应用在其中，说明它已打开（可能被挡住），不要再重复启动——用 Alt+Tab 切换，或若只是“打开”它就用 action=\"done\"。")

        marks_text = ""
        if elements:
            lines = [f"  {i+1}. {e['type'].replace('Control','')}: {e['name']}" for i, e in enumerate(elements)]
            marks_text = "\n可点击的标记（mark 编号 -> 控件）:\n" + "\n".join(lines)

        user_text = (
            f"任务: {task}\n"
            f"截图尺寸: {w} x {h} 像素（若用 x/y，坐标请用这个尺寸）\n"
            f"已完成动作:\n{hist_text}\n"
            f"{marks_text}\n"
            f"{hint}{proc_hint}\n\n"
            f"请给出第 {step} 步的单个动作 JSON（优先用 mark 点控件）。"
        )

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ]},
        ]

        try:
            content = call_model_retry(base, model, api_key, messages)
        except Exception as e:
            log(f"  模型调用失败: {e}")
            if cleanup:
                cleanup_dialogs(dry_run)
            return 2

        action = parse_action(content)
        if not action:
            log(f"  模型返回无法解析，下一步重试: {content[:150]!r}")
            continue

        thought = action.get("thought", "")
        if thought:
            log(f"  思考: {thought}")

        sig_key = action_signature(action)
        repeat_count = repeat_count + 1 if sig_key == last_sig else 0
        last_sig = sig_key
        if repeat_count >= 3:
            log(f"  ⛔ 同一动作重复 {repeat_count + 1} 次，判定卡住，中止。")
            if cleanup:
                cleanup_dialogs(dry_run)
            return 1

        result = execute(action, scale, elements, dry_run)
        mark = action.get("mark")
        if mark is not None:
            try:
                idx = int(mark) - 1
                if 0 <= idx < len(elements):
                    hist_desc = f"{action.get('action')} '{elements[idx]['name']}'"
                else:
                    hist_desc = f"{action.get('action')} mark={mark}(无效)"
            except Exception:
                hist_desc = f"{action.get('action')} mark={mark}"
        else:
            hist_desc = (f"{action.get('action')} "
                         f"{json.dumps({k: v for k, v in action.items() if k not in ('thought', 'action')}, ensure_ascii=False)}")
        history.append(hist_desc)

        if result == "done":
            log(f"✅ 完成：{action.get('summary', '')}")
            return 0
        if result == "fail":
            log(f"❌ 失败：{action.get('summary', '')}")
            if cleanup:
                cleanup_dialogs(dry_run)
            return 1

        time.sleep(delay)

    log(f"⚠️ 达到最大步数 {max_steps}，停止。")
    if cleanup:
        cleanup_dialogs(dry_run)
    return 1


def main():
    ap = argparse.ArgumentParser(description="拟人化桌面 GUI 识别/操作系统")
    ap.add_argument("--task", required=True, help="要完成的任务，例如：打开记事本")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--base", default=os.environ.get("DESKTOP_AGENT_BASE", DEFAULT_BASE))
    ap.add_argument("--max-steps", type=int, default=15)
    ap.add_argument("--delay", type=float, default=0.5, help="每步之间等待秒数")
    ap.add_argument("--dry-run", action="store_true", help="只让模型决策，不真正执行动作")
    ap.add_argument("--save-screenshots", metavar="DIR", help="把每步截图保存到该目录")
    ap.add_argument("--no-marks", dest="use_marks", action="store_false", default=True,
                    help="关闭 UIA 控件编号框（退回纯视觉坐标）")
    ap.add_argument("--cleanup", dest="cleanup", action="store_true", default=True,
                    help="中止/失败时按 Esc 清理残留对话框（默认开）")
    ap.add_argument("--no-cleanup", dest="cleanup", action="store_false")
    args = ap.parse_args()

    api_key = os.environ.get("TOKENDANCE_API_KEY")
    if not api_key:
        sys.exit(
            "未找到 API key。请先设置环境变量：\n"
            "  PowerShell:  $env:TOKENDANCE_API_KEY=\"你的key\"\n"
            "  CMD:         set TOKENDANCE_API_KEY=你的key\n"
            "  Git Bash:    export TOKENDANCE_API_KEY=你的key"
        )

    save_dir = Path(args.save_screenshots) if args.save_screenshots else None
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 0.3
    sys.exit(run(args.task, args.base, args.model, api_key, args.max_steps,
                 args.dry_run, args.delay, save_dir, args.cleanup, args.use_marks))


if __name__ == "__main__":
    main()
