---
layout: post
title: "Unreal Engine MCP: 클로드·챗지피티가 에디터를 직접 조작하는 법"
icon: paper
permalink: unrealmcp
categories: Tools
tags: [UnrealEngine, MCP, AI, LLM, Automation]
excerpt: "MCP(Model Context Protocol)가 무엇인지, 그리고 Claude·ChatGPT 같은 AI가 어떻게 언리얼 에디터에 연결되어 액터를 스폰하고 블루프린트를 짜는지"
back_color: "#ffffff"
img_name: "unrealmcp.png"
toc: false
show: true
new: true
series: -1
index: 8
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - "MCP가 도대체 뭔데 요즘 다들 얘기하지?"가 궁금한 분
> - Claude나 ChatGPT가 어떻게 *내 언리얼 에디터*를 직접 조작하는지 원리를 알고 싶은 분
> - 자연어 한 줄로 액터를 스폰하고 블루프린트를 만드는 게 코드 수준에서 어떻게 동작하는지 보고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - MCP가 풀려는 문제(M×N 통합 지옥)와 그 해법인 Host / Client / Server 구조
> - JSON-RPC 2.0 데이터 레이어와 stdio · Streamable HTTP 전송 레이어
> - 한 번의 도구 호출이 <code>initialize → tools/list → tools/call</code>로 흐르는 전체 시퀀스
> - Claude Desktop · Claude Code · ChatGPT · Cursor가 MCP 클라이언트로 붙는 방식
> - Unreal MCP 오픈소스들이 <strong>Python MCP 서버 ↔ TCP ↔ C++ 에디터 플러그인</strong>으로 연결되는 구조
> - <code>mcpServers</code> 설정 파일을 채우는 실제 방법과, 빼놓을 수 없는 보안 한계

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
.mcp-post {
  --bg2: #f4f6fb;
  --bg3: #eef0f7;
  --surface: #f9fafd;
  --surface2: #eceef7;
  --border: rgba(60,80,180,0.10);
  --border2: rgba(60,80,180,0.22);
  --text: #1a1d2e;
  --text2: #464c6a;
  --text3: #8890aa;
  --accent: #3d63e0;
  --accent2: #7248d4;
  --gold: #b07d00;
  --teal: #0a8f62;
  --coral: #d63031;
  --orange: #c85a00;
}
.mcp-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.mcp-post p { color: var(--text2); line-height: 1.85; }
.mcp-post .card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin: 24px 0;
}
.mcp-post .card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.mcp-post .card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
}
.mcp-post .card.blue::before   { background: var(--accent); }
.mcp-post .card.gold::before   { background: var(--gold); }
.mcp-post .card.teal::before   { background: var(--teal); }
.mcp-post .card.coral::before  { background: var(--coral); }
.mcp-post .card.purple::before { background: var(--accent2); }
.mcp-post .card.orange::before { background: var(--orange); }
.mcp-post .card-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.mcp-post .card.blue   .card-label { color: var(--accent); }
.mcp-post .card.gold   .card-label { color: var(--gold); }
.mcp-post .card.teal   .card-label { color: var(--teal); }
.mcp-post .card.coral  .card-label { color: var(--coral); }
.mcp-post .card.purple .card-label { color: var(--accent2); }
.mcp-post .card.orange .card-label { color: var(--orange); }
.mcp-post .card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}
.mcp-post .card-desc {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.65;
  margin: 0;
}
.mcp-post .callout {
  border-radius: 12px;
  padding: 16px 20px;
  margin: 20px 0;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.mcp-post .callout::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}
.mcp-post .callout-info { background: rgba(61,99,224,0.05); border-color: rgba(61,99,224,0.18); }
.mcp-post .callout-info::before { background: var(--accent); }
.mcp-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); }
.mcp-post .callout-warn::before { background: var(--gold); }
.mcp-post .callout-teal { background: rgba(10,143,98,0.05); border-color: rgba(10,143,98,0.20); }
.mcp-post .callout-teal::before { background: var(--teal); }
.mcp-post .callout-coral { background: rgba(214,48,49,0.05); border-color: rgba(214,48,49,0.20); }
.mcp-post .callout-coral::before { background: var(--coral); }
.mcp-post .callout-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.mcp-post .callout-info .callout-title { color: var(--accent); }
.mcp-post .callout-warn .callout-title { color: var(--gold); }
.mcp-post .callout-teal .callout-title { color: var(--teal); }
.mcp-post .callout-coral .callout-title { color: var(--coral); }
.mcp-post .callout p { margin: 0; font-size: 13px; color: var(--text2); line-height: 1.75; }
.mcp-post .code-block {
  background: #1e2230;
  border: 1px solid rgba(120,140,200,0.15);
  border-radius: 12px;
  padding: 20px 22px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  line-height: 1.85;
  overflow-x: auto;
  margin: 18px 0;
  position: relative;
  white-space: pre;
  color: #c8d0ea;
}
.mcp-post .code-block .kw  { color: #a78bfa; }
.mcp-post .code-block .fn  { color: #34d399; }
.mcp-post .code-block .cm  { color: #525a78; font-style: italic; }
.mcp-post .code-block .num { color: #fb923c; }
.mcp-post .code-block .str { color: #fbbf24; }
.mcp-post .code-block .ty  { color: #38bdf8; }
.mcp-post .code-lang {
  position: absolute;
  top: 10px; right: 14px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #525a78;
}
.mcp-post .flow-row {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin: 24px 0;
  overflow-x: auto;
}
.mcp-post .flow-step {
  flex: 1;
  min-width: 120px;
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 14px 16px;
  position: relative;
  text-align: center;
}
.mcp-post .flow-step .step-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text3);
  margin-bottom: 4px;
}
.mcp-post .flow-step .step-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}
.mcp-post .flow-step .step-desc {
  font-size: 11px;
  color: var(--text2);
  line-height: 1.5;
}
.mcp-post .flow-arrow {
  display: flex;
  align-items: center;
  padding: 0 6px;
  color: var(--text3);
  font-size: 18px;
  flex-shrink: 0;
}
.mcp-post .step-block {
  border-left: 3px solid var(--border2);
  padding: 16px 20px;
  margin: 16px 0;
  background: var(--surface);
  border-radius: 0 10px 10px 0;
}
.mcp-post .step-block.s1 { border-color: var(--coral); }
.mcp-post .step-block.s2 { border-color: var(--gold); }
.mcp-post .step-block.s3 { border-color: var(--teal); }
.mcp-post .step-block.s4 { border-color: var(--accent); }
.mcp-post .step-block h4 {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 6px;
}
.mcp-post .step-block.s1 h4 { color: var(--coral); }
.mcp-post .step-block.s2 h4 { color: var(--gold); }
.mcp-post .step-block.s3 h4 { color: var(--teal); }
.mcp-post .step-block.s4 h4 { color: var(--accent); }
.mcp-post .step-block p {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.75;
  margin: 0 0 8px 0;
}
.mcp-post .step-block p:last-child { margin-bottom: 0; }
.mcp-post .bridge {
  display: grid;
  grid-template-columns: 1fr 44px 1fr 44px 1fr;
  align-items: center;
  margin: 28px 0;
  gap: 0;
}
.mcp-post .bridge-box {
  border: 1px solid var(--border2);
  border-radius: 12px;
  padding: 16px;
  background: var(--surface);
  text-align: center;
}
.mcp-post .bridge-box .bb-tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.mcp-post .bridge-box.host  { border-color: rgba(114,72,212,0.4); }
.mcp-post .bridge-box.host  .bb-tag { color: var(--accent2); }
.mcp-post .bridge-box.srv   { border-color: rgba(61,99,224,0.4); }
.mcp-post .bridge-box.srv   .bb-tag { color: var(--accent); }
.mcp-post .bridge-box.ue    { border-color: rgba(10,143,98,0.4); }
.mcp-post .bridge-box.ue    .bb-tag { color: var(--teal); }
.mcp-post .bridge-box .bb-title { font-size: 14px; font-weight: 700; color: var(--text); margin-bottom: 4px; }
.mcp-post .bridge-box .bb-sub { font-size: 11px; color: var(--text3); line-height: 1.5; }
.mcp-post .bridge-arrow { text-align: center; }
.mcp-post .bridge-arrow .ba-sym { font-size: 20px; color: var(--text3); }
.mcp-post .bridge-arrow .ba-label {
  display: block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: var(--text3);
  margin-top: 2px;
}
.mcp-post .mtable { overflow-x: auto; margin: 24px 0; }
.mcp-post table { width: 100%; border-collapse: collapse; font-size: 13px; }
.mcp-post th {
  padding: 10px 14px; border: 1px solid var(--border);
  background: var(--surface2); color: var(--accent);
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left;
}
.mcp-post td { padding: 9px 14px; border: 1px solid var(--border); color: var(--text2); }
.mcp-post tr:nth-child(even) td { background: var(--surface); }
.mcp-post code {
  background: var(--surface2);
  padding: 1px 6px;
  border-radius: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.88em;
  color: var(--accent2);
}
.mcp-post .tldr {
  background: linear-gradient(180deg, var(--surface) 0%, var(--surface2) 100%);
  border: 1px solid var(--border2);
  border-radius: 16px;
  padding: 26px 28px 30px;
  margin: 8px 0 16px;
}
.mcp-post .tldr .tldr-tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 14px;
}
.mcp-post .tldr .tldr-lead {
  font-size: 15.5px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.7;
  margin: 0;
}
.mcp-post .tldr .tldr-lead strong { color: var(--accent2); }
.mcp-post .vflow {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  margin: 22px 0 6px;
}
.mcp-post .vflow .vnode {
  width: 100%;
  max-width: 360px;
  text-align: center;
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 11px 14px;
  background: #fff;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text);
}
.mcp-post .vflow .vnode .vsub {
  display: block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text3);
  margin-top: 2px;
}
.mcp-post .vflow .vnode.n1 { border-color: rgba(114,72,212,0.45); }
.mcp-post .vflow .vnode.n2 { border-color: rgba(61,99,224,0.45); }
.mcp-post .vflow .vnode.n3 { border-color: rgba(200,90,0,0.40); }
.mcp-post .vflow .vnode.n4 { border-color: rgba(10,143,98,0.45); }
.mcp-post .vflow .vnode.n5 { border-color: rgba(10,143,98,0.30); background: var(--surface); }
.mcp-post .vflow .varrow {
  color: var(--text3);
  font-size: 15px;
  line-height: 1.1;
  padding: 5px 0;
}
.mcp-post .vflow .varrow .valabel {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  color: var(--text3);
  margin-left: 6px;
}
.mcp-post .tldr .tldr-note {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.7;
  margin: 16px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.mcp-post .finale {
  margin: 30px 0 8px;
  padding: 30px 32px;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(61,99,224,0.09), rgba(114,72,212,0.10));
  border: 1px solid var(--border2);
  text-align: center;
}
.mcp-post .finale .finale-big {
  font-size: 20px;
  font-weight: 800;
  color: var(--text);
  line-height: 1.6;
  margin: 0;
  letter-spacing: -0.01em;
}
.mcp-post .finale .finale-big em { color: var(--accent2); font-style: normal; }
.mcp-post .finale .finale-sub {
  font-size: 13.5px;
  color: var(--text2);
  line-height: 1.75;
  margin: 14px auto 0;
  max-width: 620px;
}
</style>

<div class="mcp-post">

<div class="tldr">
<div class="tldr-tag">3줄 요약</div>
<p class="tldr-lead">
<strong>MCP</strong>는 AI와 외부 프로그램을 잇는 표준이다.<br>
<strong>Unreal MCP</strong>는 그 표준 위에서 AI가 언리얼 에디터를 조작하게 한다.<br>
구조는 아래 한 줄로 흐른다 — AI는 도구를 호출할 뿐, 엔진은 플러그인이 만진다.
</p>

<div class="vflow">
<div class="vnode n1">Claude / ChatGPT <span class="vsub">자연어 → 도구 호출</span></div>
<div class="varrow">↓<span class="valabel">stdio · MCP / JSON-RPC</span></div>
<div class="vnode n2">Python MCP 서버 <span class="vsub">FastMCP · 명령으로 번역</span></div>
<div class="varrow">↓<span class="valabel">TCP 소켓 (localhost:55557)</span></div>
<div class="vnode n3">TCP — 자체 명령(JSON)</div>
<div class="varrow">↓</div>
<div class="vnode n4">Unreal 플러그인 (C++) <span class="vsub">에디터 안에서 수신·디스패치</span></div>
<div class="varrow">↓</div>
<div class="vnode n5">Editor / Engine API <span class="vsub">SpawnActor … 실제 작업</span></div>
</div>

<p class="tldr-note">
이 글에서는 <strong>왜 이렇게 설계되었는지</strong>(M×N 문제, LSP의 발상)부터, 프로토콜 메시지와 <strong>실제 코드</strong>(<code>spawn_actor</code>가 4번 변신하는 과정)까지 따라간다.
</p>
</div>

<span class="section-eyebrow">00 — 개요</span>
</div>

# Unreal MCP란 무엇인가

<div class="mcp-post">
<p>
"에디터에서 큐브 100개를 격자로 깔고, 각각에 회전 애니메이션 블루프린트를 붙여줘." — 이 문장을 <strong>Claude나 ChatGPT 채팅창에 그냥 입력</strong>하면, 실제로 떠 있는 언리얼 에디터에 액터가 생겨나고 블루프린트 그래프가 그려진다. 이걸 가능하게 하는 접착제가 <strong>MCP(Model Context Protocol)</strong>다.
</p>

<p>
이 글은 두 가지를 따라간다. 먼저 <em>MCP가 무엇이고 왜 생겼는지</em>, 그리고 그것이 <em>Claude·ChatGPT 같은 AI를 어떻게 언리얼 에디터에 연결하는지</em>를 프로토콜 메시지와 오픈소스 구현 코드 수준에서 본다. MCP 자체는 게임 엔진과 아무 상관 없는 범용 표준이고, "언리얼을 조작한다"는 건 그 표준 위에 누군가가 올린 <strong>하나의 서버 구현</strong>일 뿐이라는 점이 핵심이다.
</p>

<div class="callout callout-info">
<div class="callout-title">한 줄 요약</div>
<p>MCP는 <strong>AI 앱(Host)</strong>과 <strong>외부 능력(Server)</strong>을 잇는 표준 규격이다. "언리얼 MCP"는 그 Server 자리에 <strong>언리얼 에디터를 조종하는 프로그램</strong>을 끼워 넣은 것이다. AI는 언리얼을 모른 채, 그저 표준대로 "도구를 호출"할 뿐이다.</p>
</div>

<span class="section-eyebrow">01 — 배경</span>
</div>

# 배경: M×N 통합 지옥

<div class="mcp-post">
<p>
LLM은 똑똑하지만 <strong>고립</strong>되어 있다. 모델 자체는 내 디스크의 파일도, 사내 DB도, 지금 켜 있는 언리얼 에디터의 상태도 모른다. 이 격리를 풀려면 "AI ↔ 외부 시스템" 연결을 일일이 만들어야 하는데, 여기서 조합 폭발이 일어난다.
</p>

<p>
AI 앱이 <code>M</code>개(Claude, ChatGPT, Cursor …), 붙이고 싶은 도구가 <code>N</code>개(GitHub, Slack, 언리얼 …)라면, 순진하게는 <code>M×N</code>개의 전용 커넥터를 각각 짜야 한다. 도구 하나가 늘 때마다 모든 AI 앱이 새 통합을 추가해야 한다. Anthropic은 2024년 11월 25일 MCP를 오픈소스로 공개하면서 이 문제를 <strong>"USB-C 같은 표준 단자"</strong>로 풀자고 제안했다. 모두가 같은 규격을 따르면 <code>M×N</code>이 <code>M+N</code>으로 줄어든다.
</p>

<div class="card-grid">
<div class="card coral">
<div class="card-label">문제</div>
<div class="card-title">M×N 커넥터</div>
<div class="card-desc">AI 앱마다, 도구마다 전용 연결을 작성. 도구 하나 추가 = 모든 앱이 작업. 확장이 곱셈으로 늘어난다.</div>
</div>
<div class="card teal">
<div class="card-label">해법</div>
<div class="card-title">공통 프로토콜</div>
<div class="card-desc">도구 쪽은 <strong>MCP 서버</strong> 하나만, 앱 쪽은 <strong>MCP 클라이언트</strong> 하나만 구현. 양쪽 모두 같은 규격을 말한다.</div>
</div>
<div class="card blue">
<div class="card-label">설계 출처</div>
<div class="card-title">LSP에서 빌려옴</div>
<div class="card-desc">에디터 × 언어 조합을 풀었던 <strong>Language Server Protocol</strong>의 메시지 흐름을 그대로 차용. 전송은 JSON-RPC 2.0.</div>
</div>
</div>

<div class="callout callout-teal">
<div class="callout-title">왜 LSP 비유가 정확한가</div>
<p>VS Code가 파이썬·러스트·고를 각각 특별 대우하지 않는다. 언어마다 <strong>Language Server</strong>가 표준 메시지로 "이 위치의 정의로 가기", "자동완성 목록"을 제공할 뿐이다. MCP는 같은 발상을 "AI ↔ 도구"로 옮겼다. 언리얼 에디터는 자기를 조종하는 <strong>한 종류의 서버</strong>가 되고, 어떤 AI 앱이든 표준 클라이언트면 붙는다.</p>
</div>

<span class="section-eyebrow">02 — 아키텍처</span>
</div>

# 세 참가자: Host · Client · Server

<div class="mcp-post">
<p>
MCP는 <strong>클라이언트–서버 구조</strong>다. 다만 용어가 셋으로 나뉜다. 공식 문서의 정의를 그대로 정리하면 이렇다.
</p>

<div class="card-grid">
<div class="card purple">
<div class="card-label">MCP Host</div>
<div class="card-title">AI 애플리케이션</div>
<div class="card-desc">Claude Desktop, Claude Code, Cursor, VS Code처럼 사용자가 마주하는 앱. 여러 클라이언트를 만들고 조율한다.</div>
</div>
<div class="card blue">
<div class="card-label">MCP Client</div>
<div class="card-title">전용 연결 1:1</div>
<div class="card-desc">Host가 <strong>서버 하나당 하나씩</strong> 생성하는 내부 객체. 해당 서버와의 연결을 전담한다.</div>
</div>
<div class="card teal">
<div class="card-label">MCP Server</div>
<div class="card-title">능력 제공자</div>
<div class="card-desc">Client에 컨텍스트와 도구를 제공하는 프로그램. 로컬일 수도 원격일 수도 있다. <strong>여기에 언리얼이 들어간다.</strong></div>
</div>
</div>

<p>
즉 Host 하나가 GitHub 서버, 파일시스템 서버, 언리얼 서버에 동시에 연결한다면 그 안에는 클라이언트 객체가 셋 만들어진다. 각 클라이언트는 자기 서버하고만 대화한다.
</p>

<h2>두 개의 레이어</h2>

<p>
MCP는 안쪽의 <strong>데이터 레이어</strong>와 바깥쪽의 <strong>전송 레이어</strong>로 나뉜다. 이 분리가 "노트북에서 돌든 클라우드에서 돌든 같은 메시지"를 가능하게 한다.
</p>

<div class="mtable">
<table>
<thead>
<tr><th style="width:22%;">레이어</th><th>역할</th></tr>
</thead>
<tbody>
<tr><td><strong>데이터 레이어</strong></td><td><strong>JSON-RPC 2.0</strong> 기반 메시지 규약. 연결 수명 관리(lifecycle), 능력 협상, 그리고 핵심 primitives(tools·resources·prompts)와 알림(notifications)을 정의한다. <em>무엇을 주고받는가.</em></td></tr>
<tr><td><strong>전송 레이어</strong></td><td>실제 통신 채널. 연결 수립, 메시지 프레이밍, 인증을 담당한다. <em>어떻게 실어 나르는가.</em></td></tr>
</tbody>
</table>
</div>

<h2>전송 방식 두 가지</h2>

<div class="card-grid">
<div class="card gold">
<div class="card-label">stdio</div>
<div class="card-title">로컬 프로세스 직결</div>
<div class="card-desc">표준 입출력 스트림으로 같은 머신의 프로세스끼리 통신. 네트워크 오버헤드가 없어 가장 빠르다. 로컬 서버의 기본값 — <strong>언리얼 MCP가 대부분 이 방식</strong>이다.</div>
</div>
<div class="card orange">
<div class="card-label">Streamable HTTP</div>
<div class="card-title">원격 서버용</div>
<div class="card-desc">클라이언트→서버는 HTTP POST, 스트리밍은 선택적 <strong>SSE(Server-Sent Events)</strong>. 베어러 토큰·API 키 등 표준 HTTP 인증을 쓰며, 토큰 획득은 OAuth 권장.</div>
</div>
</div>

<h2>서버가 노출하는 primitives</h2>

<p>
프로토콜의 핵심은 <strong>primitives</strong>다. 서버가 클라이언트에게 무엇을 줄 수 있는지를 정의한다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">tools</div>
<div class="card-title">실행 가능한 함수</div>
<div class="card-desc">AI가 호출해 <strong>행동</strong>을 일으킨다. "액터 스폰", "블루프린트 컴파일" 같은 게 전부 도구다. 언리얼 MCP의 본체.</div>
</div>
<div class="card teal">
<div class="card-label">resources</div>
<div class="card-title">맥락 데이터</div>
<div class="card-desc">읽어 들이는 정보원. 파일 내용, 씬 상태, DB 레코드 등. AI가 판단의 근거로 삼는 컨텍스트.</div>
</div>
<div class="card purple">
<div class="card-label">prompts</div>
<div class="card-title">재사용 템플릿</div>
<div class="card-desc">상호작용을 구조화하는 프롬프트 틀. 시스템 프롬프트나 few-shot 예시처럼 패턴화된 지시.</div>
</div>
</div>

<p>
반대로 <strong>클라이언트</strong>도 서버에게 능력을 노출할 수 있다. <code>sampling</code>(서버가 Host의 LLM에 완성을 요청), <code>elicitation</code>(서버가 사용자에게 추가 입력·확인을 요청), <code>logging</code>(서버가 로그를 보냄)이 그것이다. 덕분에 서버는 자체 LLM SDK 없이도 모델에 접근할 수 있다.
</p>

<span class="section-eyebrow">03 — 한 번의 호출</span>
</div>

# 도구 호출의 전체 시퀀스

<div class="mcp-post">
<p>
MCP는 <strong>상태가 있는(stateful)</strong> 프로토콜이라 연결 수명 관리가 필요하다. 클라이언트가 서버에 처음 붙는 순간부터 도구를 실행하기까지의 흐름은 항상 같은 모양을 따른다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">1</div><div class="step-name">initialize</div><div class="step-desc">프로토콜 버전·능력 협상 핸드셰이크</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">2</div><div class="step-name">tools/list</div><div class="step-desc">서버가 가진 도구 목록·스키마 조회</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">3</div><div class="step-name">tools/call</div><div class="step-desc">인자를 담아 실제 도구 실행</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">4</div><div class="step-name">result</div><div class="step-desc">content 배열로 결과 반환</div></div>
</div>

<div class="step-block s1">
<h4>1. initialize — 악수와 능력 협상</h4>
<p>클라이언트가 자신이 지원하는 <code>protocolVersion</code>과 capabilities를 보내고, 서버가 자기 capabilities로 답한다. 서로 맞는 버전이 없으면 연결을 끊는다. 끝나면 클라이언트가 <code>notifications/initialized</code>로 "준비됨"을 알린다.</p>
</div>

<div class="code-block"><span class="code-lang">json-rpc · 요청</span><span class="cm">// Client → Server</span>
{
  <span class="str">"jsonrpc"</span>: <span class="str">"2.0"</span>, <span class="str">"id"</span>: <span class="num">1</span>,
  <span class="str">"method"</span>: <span class="str">"initialize"</span>,
  <span class="str">"params"</span>: {
    <span class="str">"protocolVersion"</span>: <span class="str">"2025-06-18"</span>,
    <span class="str">"capabilities"</span>: { <span class="str">"elicitation"</span>: {} },
    <span class="str">"clientInfo"</span>: { <span class="str">"name"</span>: <span class="str">"example-client"</span>, <span class="str">"version"</span>: <span class="str">"1.0.0"</span> }
  }
}</div>

<div class="step-block s2">
<h4>2. tools/list — 도구 카탈로그 받기</h4>
<p>클라이언트가 빈 요청을 보내면 서버는 도구 배열을 돌려준다. 각 도구는 <code>name</code>, <code>title</code>, <code>description</code>, 그리고 인자 검증용 <code>inputSchema</code>(JSON Schema)를 갖는다. Host는 이 목록을 LLM이 볼 수 있는 통합 도구 레지스트리에 합친다.</p>
</div>

<div class="code-block"><span class="code-lang">json-rpc · 응답</span><span class="cm">// Server → Client : 도구 하나의 모양</span>
{
  <span class="str">"name"</span>: <span class="str">"spawn_actor"</span>,
  <span class="str">"title"</span>: <span class="str">"Spawn Actor"</span>,
  <span class="str">"description"</span>: <span class="str">"레벨에 액터를 생성한다"</span>,
  <span class="str">"inputSchema"</span>: {
    <span class="str">"type"</span>: <span class="str">"object"</span>,
    <span class="str">"properties"</span>: {
      <span class="str">"type"</span>:     { <span class="str">"type"</span>: <span class="str">"string"</span> },
      <span class="str">"location"</span>: { <span class="str">"type"</span>: <span class="str">"array"</span> }
    },
    <span class="str">"required"</span>: [<span class="str">"type"</span>]
  }
}</div>

<div class="step-block s3">
<h4>3. tools/call — 실행</h4>
<p>LLM이 "이 도구를 쓰겠다"고 결정하면 Host가 그 호출을 가로채 해당 서버로 라우팅한다. <code>name</code>은 목록에서 받은 이름과 정확히 일치해야 하고, <code>arguments</code>는 스키마를 따른다.</p>
</div>

<div class="code-block"><span class="code-lang">json-rpc · 요청</span>{
  <span class="str">"jsonrpc"</span>: <span class="str">"2.0"</span>, <span class="str">"id"</span>: <span class="num">3</span>,
  <span class="str">"method"</span>: <span class="str">"tools/call"</span>,
  <span class="str">"params"</span>: {
    <span class="str">"name"</span>: <span class="str">"spawn_actor"</span>,
    <span class="str">"arguments"</span>: { <span class="str">"type"</span>: <span class="str">"StaticMeshActor"</span>, <span class="str">"location"</span>: [<span class="num">0</span>, <span class="num">0</span>, <span class="num">100</span>] }
  }
}</div>

<div class="callout callout-info">
<div class="callout-title">동적 갱신 — notifications</div>
<p>서버의 도구 목록이 바뀌면(새 기능 추가 등) 서버는 <code>notifications/tools/list_changed</code>를 보낸다. <code>id</code>가 없는 JSON-RPC 알림이라 응답을 기대하지 않는다. 클라이언트는 이를 받고 <code>tools/list</code>를 다시 호출해 레지스트리를 갱신한다. 폴링 없이 실시간으로 동기화되는 구조다.</p>
</div>

<span class="section-eyebrow">04 — 생태계</span>
</div>

# 누가 MCP 클라이언트인가

<div class="mcp-post">
<p>
MCP가 의미 있으려면 "표준"이어야 한다. 한 회사만 쓰면 그냥 사내 규격이다. 2024년 말 공개 이후 1년 반 만에 MCP는 주요 AI 앱 대부분이 지원하는 사실상의 표준이 됐다.
</p>

<div class="step-block s4">
<h4>Anthropic — Claude</h4>
<p><strong>Claude Desktop</strong>과 <strong>Claude Code</strong>가 대표적인 Host다. MCP의 제안자답게 처음부터 핵심 클라이언트였고, Python·TypeScript·C#·Java SDK와 Google Drive·Slack·GitHub·Git·Postgres 등 사전 제작 서버를 함께 공개했다.</p>
</div>

<div class="step-block s3">
<h4>OpenAI — ChatGPT</h4>
<p>경쟁사 표준이지만 OpenAI는 2025년 3월 MCP를 공식 채택했다. <strong>Agents SDK</strong>에 먼저 들어갔고, 이어 <strong>Responses API</strong>, ChatGPT 데스크톱/Developer Mode 커넥터로 확대됐다. OpenAI는 MCP 운영 위원회(steering committee)에도 합류했다. Sam Altman은 MCP를 "에이전트가 도구·데이터와 안전하게 상호작용하기 위해 빠르게 떠오르는 핵심 개방 표준"이라 평했다.</p>
</div>

<div class="step-block s2">
<h4>그 외 — Cursor · Windsurf · VS Code …</h4>
<p>코드 에디터 진영이 빠르게 붙었다. Cursor·Windsurf·VS Code가 모두 MCP Host로 동작한다. 언리얼 MCP가 "Cursor에서도, Claude Desktop에서도 똑같이 된다"고 말할 수 있는 이유가 여기 있다 — 서버는 하나, 클라이언트는 여럿.</p>
</div>

<div class="callout callout-warn">
<div class="callout-title">중요한 구분</div>
<p>로컬 <strong>stdio</strong> 서버를 직접 띄우는 건 Claude Desktop·Cursor처럼 데스크톱 Host의 특기다. ChatGPT는 주로 <strong>원격(Streamable HTTP) 커넥터</strong>나 Agents SDK를 통해 MCP에 붙는 모델이라, 내 PC의 언리얼 같은 로컬 stdio 서버를 붙이려면 별도 노출(터널링·원격 래핑)이 필요할 수 있다. "둘 다 MCP를 지원한다"가 "설정이 똑같다"를 뜻하지는 않는다.</p>
</div>

<span class="section-eyebrow">05 — 언리얼 연결</span>
</div>

# Unreal MCP: 어떻게 에디터에 붙나

<div class="mcp-post">
<p>
이제 본론이다. AI가 언리얼을 조작한다는 건 결국 <strong>"언리얼 에디터를 조종하는 MCP 서버"</strong>가 존재한다는 뜻이다. 그런데 여기에 함정이 하나 있다. <strong>MCP 서버 자체는 언리얼 안에서 도는 게 아니다.</strong> 대부분의 오픈소스 구현은 두 조각으로 나뉜다.
</p>

<div class="bridge">
<div class="bridge-box host">
<div class="bb-tag">MCP Host</div>
<div class="bb-title">Claude / Cursor</div>
<div class="bb-sub">사용자가 자연어 입력</div>
</div>
<div class="bridge-arrow">
<span class="ba-sym">⇄</span>
<span class="ba-label">stdio<br>(MCP / JSON-RPC)</span>
</div>
<div class="bridge-box srv">
<div class="bb-tag">MCP Server</div>
<div class="bb-title">Python 서버</div>
<div class="bb-sub">FastMCP · 도구 정의</div>
</div>
<div class="bridge-arrow">
<span class="ba-sym">⇄</span>
<span class="ba-label">TCP 소켓<br>(자체 프로토콜)</span>
</div>
<div class="bridge-box ue">
<div class="bb-tag">Unreal Editor</div>
<div class="bb-title">C++ 플러그인</div>
<div class="bb-sub">TCP 서버 · 엔진 API 실행</div>
</div>
</div>

<p>
즉 연결은 <strong>두 단의 통신</strong>이다. 바깥쪽은 AI 앱 ↔ 파이썬 서버를 잇는 <strong>MCP(stdio·JSON-RPC)</strong>, 안쪽은 파이썬 서버 ↔ 언리얼 플러그인을 잇는 <strong>별도의 TCP 소켓</strong>이다. 파이썬 서버는 MCP 도구 호출을 받아 그것을 직렬화된 명령으로 바꿔 언리얼 플러그인에 던지고, 플러그인이 그 명령을 엔진 API로 실행한다.
</p>

<div class="callout callout-teal">
<div class="callout-title">왜 굳이 둘로 나눌까</div>
<p>MCP SDK(특히 파이썬 FastMCP)는 파이썬 생태계가 가장 성숙하다. 반면 액터 스폰·블루프린트 편집 같은 실제 작업은 언리얼 엔진 안에서만 가능하다. 그래서 <strong>MCP 말하기는 파이썬이, 엔진 만지기는 C++ 플러그인이</strong> 맡고, 둘을 로컬 TCP 소켓으로 잇는 구조가 정착했다. 플러그인이 에디터 안에서 TCP <em>서버</em>로 떠 있고, 파이썬 MCP 서버가 그 <em>클라이언트</em>가 된다는 점이 헷갈리기 쉽다.</p>
</div>

<h2>세 개의 "프로세스"로 보기</h2>

<p>
위 그림의 세 박스는 단순한 모듈이 아니라 <strong>운영체제 프로세스가 각각 따로 떠 있는 것</strong>이다. 이 점이 동작과 실패를 이해하는 열쇠다.
</p>

<div class="mtable">
<table>
<thead>
<tr><th>프로세스</th><th>정체</th><th>누가 띄우나</th></tr>
</thead>
<tbody>
<tr><td><strong>① Claude Desktop .exe</strong><br>(또는 Cursor 등)</td><td>AI 채팅 앱 = MCP Host</td><td>사용자가 직접 실행</td></tr>
<tr><td><strong>② python.exe</strong><br>(<code>unreal_mcp_server.py</code>)</td><td>MCP 서버 = 별도 파이썬 프로세스</td><td><strong>①이 자동으로</strong> 자식 프로세스로 실행<br>(<code>mcpServers</code>의 <code>command</code>/<code>args</code>가 그 지시)</td></tr>
<tr><td><strong>③ UnrealEditor.exe</strong></td><td>켜져 있는 에디터. 그 <strong>안에</strong> C++ 플러그인이 로드되어 TCP 서버로 동작</td><td>사용자가 미리 에디터를 켜둠</td></tr>
</tbody>
</table>
</div>

<p>
①↔② 사이는 <strong>stdio</strong>(표준 입출력 파이프)로 MCP/JSON-RPC가 흐르고, ②↔③ 사이는 <strong>localhost TCP 소켓</strong>(예: <code>55557</code>)으로 자체 명령이 흐른다. 게임 빌드(<code>MyGame.exe</code>)가 아니라 <strong>에디터 프로세스</strong>가 상대라는 점, 그리고 ②가 아무리 떠 있어도 <strong>③(에디터)이 꺼져 있으면 명령이 갈 곳이 없어 실패</strong>한다는 점이 핵심이다.</p>

<h2>C++ 플러그인의 정체</h2>

<p>
그렇다면 ③ 안에서 도는 그 "C++ 플러그인"은 무엇인가. chongdashu/unreal-mcp의 경우 이름은 그대로 <strong><code>UnrealMCP</code></strong>이고, 형태는 <strong>여느 언리얼 플러그인과 똑같다</strong> — <code>.uplugin</code> 매니페스트 하나에 C++ <code>Source</code> 모듈 하나. 프로젝트의 <code>Plugins/UnrealMCP/</code>에 넣고 빌드하면 에디터가 시작될 때 모듈을 로드한다. 내부는 역할별로 단출하게 나뉜다.
</p>

<div class="code-block"><span class="code-lang">Plugins/UnrealMCP/Source/UnrealMCP/</span>Private/
├─ <span class="ty">UnrealMCPModule</span>.cpp        <span class="cm">// 모듈 진입점. 로드 시 ②③ 다리(서버)를 띄움</span>
├─ <span class="ty">MCPServerRunnable</span>.cpp      <span class="cm">// FRunnable — 백그라운드 TCP 수신 스레드 (포트 55557)</span>
├─ <span class="ty">UnrealMCPBridge</span>.cpp        <span class="cm">// 명령 디스패처. JSON을 까서 도메인별 핸들러로 분배</span>
└─ Commands/                    <span class="cm">// 도메인별 명령 핸들러들</span>
   ├─ <span class="ty">UnrealMCPEditorCommands</span>.cpp        <span class="cm">// 액터·뷰포트·카메라</span>
   ├─ <span class="ty">UnrealMCPBlueprintCommands</span>.cpp     <span class="cm">// 블루프린트 클래스/컴포넌트</span>
   ├─ <span class="ty">UnrealMCPBlueprintNodeCommands</span>.cpp <span class="cm">// 블루프린트 노드 그래프</span>
   ├─ <span class="ty">UnrealMCPUMGCommands</span>.cpp           <span class="cm">// UMG 위젯</span>
   ├─ <span class="ty">UnrealMCPProjectCommands</span>.cpp       <span class="cm">// 프로젝트 설정</span>
   └─ <span class="ty">UnrealMCPCommonUtils</span>.cpp           <span class="cm">// 공통 JSON/변환 헬퍼</span></div>

<p>
형태를 풀어 쓰면 세 가지 책임으로 나뉜다.
</p>

<div class="step-block s2">
<h4>① 모듈 — UnrealMCPModule</h4>
<p>플러그인의 진입점(<code>IModuleInterface</code>). 에디터가 모듈을 로드할 때 <code>StartupModule()</code>에서 TCP 수신 스레드와 디스패처를 띄우고, 종료 시 정리한다. "언제 살아나고 죽는가"를 책임진다.</p>
</div>

<div class="step-block s1">
<h4>② 수신 스레드 — MCPServerRunnable</h4>
<p>언리얼의 <code>FRunnable</code>(백그라운드 스레드)로, 포트 <code>55557</code>에서 TCP 연결을 받아 파이썬 서버가 보낸 JSON 명령을 읽는다. 게임 스레드를 막지 않으려고 별도 스레드에서 돌고, 받은 명령은 디스패처에 넘긴다.</p>
</div>

<div class="step-block s4">
<h4>③ 디스패처 + 핸들러 — UnrealMCPBridge / Commands</h4>
<p>디스패처가 JSON의 명령 이름을 보고 알맞은 <code>Commands/</code> 핸들러로 분배한다. 각 핸들러는 실제 엔진·에디터 API(<code>UEditorActorSubsystem</code> 등)를 호출해 작업을 수행하고 결과 JSON을 되돌린다. "액터 스폰"은 EditorCommands가, "블루프린트 컴파일"은 BlueprintCommands가 맡는 식으로, <strong>도메인이 늘면 핸들러 파일을 추가</strong>한다.</p>
</div>

<div class="callout callout-info">
<div class="callout-title">정리하면</div>
<p>플러그인은 특별한 마법이 아니라 <strong>"에디터 안에서 TCP를 듣다가, 들어온 JSON 명령을 엔진 API 호출로 번역해 주는 통역사"</strong>다. 구현마다 이름과 포트가 다를 뿐(kvick-games는 별도 플러그인 + 포트 <code>13377</code>), 이 골격은 공통이다. 통로로 자체 TCP 대신 언리얼 기본 제공 <strong>Remote Control API</strong>나 <strong>Python Remote Execution</strong>을 쓰는 구현도 있는데, "에디터 안에서 명령을 받아주는 무언가"가 필요하다는 구조는 똑같다.</p>
</div>

<h2>대표 오픈소스 세 갈래</h2>

<p>
같은 발상에서 출발했지만 성숙도와 범위가 다른 구현들이 있다. 검증된 세 가지를 비교하면 이렇다.
</p>

<div class="mtable">
<table>
<thead>
<tr><th>프로젝트</th><th>구조 / 포트</th><th>노출 도구</th><th>성격</th></tr>
</thead>
<tbody>
<tr>
<td><strong>chongdashu/<br>unreal-mcp</strong></td>
<td>Python(FastMCP) ↔ C++ 플러그인, TCP <code>55557</code>. UE 5.5+, Python 3.12+</td>
<td>Actor 관리 · Blueprint 작성 · Blueprint 노드 그래프 · Editor 제어(뷰포트·카메라)</td>
<td>가장 널리 인용. 블루프린트 노드 그래프까지 다룸. 명시적으로 <strong>실험적(experimental)</strong></td>
</tr>
<tr>
<td><strong>kvick-games/<br>UnrealMCP</strong></td>
<td>C++ 플러그인이 TCP 서버, 포트 <code>13377</code>. <strong>blender-mcp</strong>를 참고해 구현</td>
<td><code>get_scene_info</code> · <code>create_object</code> · <code>delete_object</code> · <code>modify_object</code> · <code>execute_python</code></td>
<td>초기·단순. 씬 조작 + <strong>임의 파이썬 실행</strong>이 핵심</td>
</tr>
<tr>
<td><strong>flopperam/<br>unreal-engine-mcp</strong></td>
<td>로컬 Python 서버 + C++ 플러그인. UE 5.5+</td>
<td><strong>50+ 도구, 9개 도메인</strong>: 블루프린트·머티리얼·VFX·애니메이션·랜드스케이프·AI/BT·시네마틱·PCG …</td>
<td>가장 광범위. 마을·미로·구조물 등 대규모 씬 생성 지향</td>
</tr>
</tbody>
</table>
</div>

<p>
이 외에도 순수 파이썬 구현(runeape-sats), TypeScript + C++ Automation Bridge 구현(ChiR24) 등 파생이 계속 나오고 있다. 공통점은 분명하다 — <strong>파이썬(또는 TS) MCP 서버 + 언리얼 에디터 플러그인 + 둘 사이의 로컬 소켓</strong>. 다른 점은 도구의 수와 깊이다.
</p>

<div class="callout callout-info">
<div class="callout-title">execute_python 이라는 만능 열쇠</div>
<p>kvick-games 구현의 <code>execute_python</code>은 흥미로운 설계다. 액터 스폰·삭제처럼 도구를 하나하나 정의하는 대신, "언리얼 파이썬 코드를 통째로 실행"하는 도구 하나를 둔다. 언리얼은 에디터 스크립팅용 파이썬 API를 제공하므로, AI가 파이썬을 짜서 보내면 거의 무엇이든 할 수 있다. <strong>유연함의 극단이지만, 곧 보안의 핵심 위험이기도 하다</strong>(08장).</p>
</div>

<h2>결국 "구현된 명령"만 실행된다</h2>

<p>
이 구조의 중요한 성질 하나 — AI가 할 수 있는 일은 <strong>플러그인 디스패처에 핸들러가 있는 명령</strong>으로 한정된다. <code>tools/list</code>에 오른 도구만 호출 가능하고, 각 도구는 C++ 핸들러 하나에 대응한다. 디스패처가 모르는 명령이 오면 그냥 에러다. <strong>새 동작을 원하면 코드를 늘려야 한다</strong> — 파이썬에 <code>@mcp.tool</code> 함수 하나, C++에 핸들러 하나를 추가하고 에디터를 다시 빌드. 한쪽만 있으면 호출은 가도 처리가 안 된다.
</p>

<div class="mtable">
<table>
<thead>
<tr><th>구현 방식</th><th>실제 능력 범위</th></tr>
</thead>
<tbody>
<tr><td><strong>이산 명령만</strong><br>(chongdashu)</td><td>딱 <strong>구현된 명령까지.</strong> 경계가 분명해 비교적 안전 — AI가 할 수 있는 일이 명령 목록으로 진짜 한정된다</td></tr>
<tr><td><strong><code>execute_python</code> 포함</strong><br>(kvick-games)</td><td><strong>명목상 한정, 실제론 무제한.</strong> "임의 코드 실행" 명령 하나가 고정 명령 집합이라는 경계를 무력화한다 — 언리얼 파이썬 API로 거의 무엇이든</td></tr>
</tbody>
</table>
</div>

<div class="callout callout-warn">
<div class="callout-title">경계의 예외</div>
<p>"구현된 명령만 실행된다"는 안심은, 그 명령들 중 하나가 <strong>"아무 코드나 실행"</strong>이 아닐 때만 성립한다. <code>execute_python</code>이 끼는 순간 명령 집합이라는 샌드박스는 명목상으로만 남는다. 이것이 08장 보안에서 임의 코드 실행을 위험의 핵심으로 꼽는 이유다.</p>
</div>

<span class="section-eyebrow">06 — 설정</span>
</div>

# 실제로 붙이기: mcpServers 설정

<div class="mcp-post">
<p>
Host가 어떤 서버를 띄울지는 <strong><code>mcpServers</code> JSON</strong> 한 덩어리로 정해진다. stdio 서버의 경우 본질은 단순하다 — "이 명령어를, 이 인자로 실행해라." Host가 그 명령을 자식 프로세스로 띄우고 stdin/stdout으로 JSON-RPC를 주고받는다.
</p>

<p>
chongdashu/unreal-mcp는 파이썬 패키지 매니저 <code>uv</code>로 서버를 띄운다. 클라이언트별로 파일 위치만 다를 뿐 형식은 동일하다.
</p>

<div class="code-block"><span class="code-lang">claude_desktop_config.json</span>{
  <span class="str">"mcpServers"</span>: {
    <span class="str">"unrealMCP"</span>: {
      <span class="str">"command"</span>: <span class="str">"uv"</span>,
      <span class="str">"args"</span>: [
        <span class="str">"--directory"</span>,
        <span class="str">"&lt;path/to/the/folder/PYTHON&gt;"</span>,
        <span class="str">"run"</span>,
        <span class="str">"unreal_mcp_server.py"</span>
      ]
    }
  }
}</div>

<div class="mtable">
<table>
<thead>
<tr><th>클라이언트</th><th>설정 파일 위치</th></tr>
</thead>
<tbody>
<tr><td>Claude Desktop (Win)</td><td><code>%APPDATA%\Claude\claude_desktop_config.json</code></td></tr>
<tr><td>Cursor</td><td><code>.cursor/mcp.json</code> (프로젝트별)</td></tr>
<tr><td>Windsurf</td><td><code>~/.config/windsurf/mcp.json</code></td></tr>
</tbody>
</table>
</div>

<p>
kvick-games 구현처럼 <code>.bat</code> 진입점을 쓰는 경우도 같은 골격이다 — <code>command</code>에 배치 파일 경로를 주면 된다.
</p>

<div class="code-block"><span class="code-lang">claude_desktop_config.json</span>{
  <span class="str">"mcpServers"</span>: {
    <span class="str">"unreal"</span>: {
      <span class="str">"command"</span>: <span class="str">"C:\\UnrealMCP_Project\\Plugins\\UnrealMCP\\MCP\\run_unreal_mcp.bat"</span>,
      <span class="str">"args"</span>: []
    }
  }
}</div>

<div class="callout callout-warn">
<div class="callout-title">잊기 쉬운 전제 — 에디터가 켜져 있어야 한다</div>
<p>이 설정은 <strong>파이썬 MCP 서버</strong>만 띄운다. 정작 명령을 실행할 <strong>언리얼 플러그인의 TCP 서버</strong>는 에디터가 실행 중이고 플러그인이 활성화돼 있어야 떠 있다. 둘 사이의 소켓(예: <code>55557</code>)이 연결되지 않으면, AI는 도구를 "호출"하지만 언리얼에는 아무 일도 일어나지 않는다. 연결 실패의 단골 원인이다.</p>
</div>

<span class="section-eyebrow">07 — 전체 흐름</span>
</div>

# "큐브 100개 깔아줘"가 실행되기까지

<div class="mcp-post">
<p>
앞의 조각들을 하나의 요청으로 꿰어 보자. 사용자가 Claude Desktop에 자연어를 입력한 순간부터 에디터에 큐브가 나타나기까지.
</p>

<div class="step-block s1">
<h4>① 사용자 → Host</h4>
<p>"10×10 격자로 큐브 100개 스폰해줘." Claude(Host)는 연결된 MCP 서버들의 <code>tools/list</code> 결과를 이미 알고 있으므로, <code>spawn_actor</code> 같은 도구가 있다는 걸 안다.</p>
</div>

<div class="step-block s2">
<h4>② LLM의 판단 → tools/call</h4>
<p>모델이 작업을 100번의 <code>spawn_actor</code> 호출(또는 반복 도구 하나)로 분해한다. 각 호출은 <code>arguments</code>에 위치·타입을 담은 <code>tools/call</code> JSON-RPC 메시지로 만들어진다.</p>
</div>

<div class="step-block s3">
<h4>③ 파이썬 서버 → TCP → 플러그인</h4>
<p>파이썬 MCP 서버가 그 호출을 받아 자체 명령 포맷으로 직렬화하고, TCP 소켓(<code>55557</code> 등)을 통해 에디터 안의 C++ 플러그인에 전달한다.</p>
</div>

<div class="step-block s4">
<h4>④ 플러그인 → 엔진 API → result</h4>
<p>플러그인이 명령을 언리얼 엔진 API 호출로 바꿔 실제 액터를 스폰한다. 성공/실패를 응답으로 되돌려, 파이썬 서버가 MCP <code>result</code>(content 배열)로 포장해 Host에 반환한다. Claude는 그 결과를 보고 다음 행동(또는 사용자에게 보고)을 이어간다.</p>
</div>

<h2>알맹이: <code>spawn_actor</code> 하나가 4번 변신한다</h2>

<p>
그래서 "클로드는 뭘 던지고, 언리얼은 뭘 받아서 어떻게 액터를 만드냐"의 답은 이렇다. <strong>같은 의도가 단계마다 다른 표현으로 번역</strong>되며 흐른다. 실제 chongdashu/unreal-mcp의 <code>spawn_actor</code>를 따라가 보자.
</p>

<div class="step-block s4">
<h4>① 클로드가 "던지는" 것 — 도구 호출(JSON)</h4>
<p>모델은 C++도, 좌표 변환도 모른다. 그저 <code>tools/list</code>로 받은 스키마에 맞춰 <strong>인자만 채운</strong> 도구 호출을 만든다. 이게 클로드가 내보내는 전부다.</p>
</div>

<div class="code-block"><span class="code-lang">① MCP tools/call · Claude → 파이썬 서버</span>{
  <span class="str">"method"</span>: <span class="str">"tools/call"</span>,
  <span class="str">"params"</span>: {
    <span class="str">"name"</span>: <span class="str">"spawn_actor"</span>,
    <span class="str">"arguments"</span>: {
      <span class="str">"name"</span>:     <span class="str">"Cube_0"</span>,
      <span class="str">"type"</span>:     <span class="str">"StaticMeshActor"</span>,
      <span class="str">"location"</span>: [<span class="num">0</span>, <span class="num">0</span>, <span class="num">100</span>],
      <span class="str">"rotation"</span>: [<span class="num">0</span>, <span class="num">0</span>, <span class="num">0</span>]
    }
  }
}</div>

<div class="step-block s3">
<h4>② 파이썬 서버가 "건네는" 것 — TCP 명령(JSON)</h4>
<p>도구 함수가 인자를 받아 약간 다듬은 뒤(<code>type.upper()</code> 등), 명령 이름과 함께 소켓으로 보낸다. MCP 메시지가 <strong>내부 TCP 명령으로 번역</strong>되는 지점이다.</p>
</div>

<div class="code-block"><span class="code-lang">② 파이썬 도구 정의 (FastMCP)</span><span class="kw">@mcp.tool</span>()
<span class="kw">def</span> <span class="fn">spawn_actor</span>(ctx, name, <span class="ty">type</span>,
                location=[<span class="num">0</span>,<span class="num">0</span>,<span class="num">0</span>], rotation=[<span class="num">0</span>,<span class="num">0</span>,<span class="num">0</span>]):
    params = {
        <span class="str">"name"</span>:     name,
        <span class="str">"type"</span>:     <span class="ty">type</span>.upper(),     <span class="cm"># "STATICMESHACTOR"</span>
        <span class="str">"location"</span>: location,
        <span class="str">"rotation"</span>: rotation,
    }
    <span class="kw">return</span> unreal.send_command(<span class="str">"spawn_actor"</span>, params)</div>

<div class="code-block"><span class="code-lang">② 소켓에 흐르는 JSON (대략)</span><span class="cm">// 명령 이름 + 파라미터 봉투. 구현마다 봉투 키는 조금씩 다르다.</span>
{ <span class="str">"type"</span>: <span class="str">"spawn_actor"</span>,
  <span class="str">"params"</span>: { <span class="str">"name"</span>: <span class="str">"Cube_0"</span>, <span class="str">"type"</span>: <span class="str">"STATICMESHACTOR"</span>,
             <span class="str">"location"</span>: [<span class="num">0</span>,<span class="num">0</span>,<span class="num">100</span>], <span class="str">"rotation"</span>: [<span class="num">0</span>,<span class="num">0</span>,<span class="num">0</span>] } }</div>

<div class="step-block s1">
<h4>③ 플러그인이 "받아서" 하는 것 — JSON 파싱 + SpawnActor</h4>
<p>디스패처가 명령 이름 <code>spawn_actor</code>를 보고 EditorCommands 핸들러로 보낸다. 핸들러가 JSON 필드를 하나씩 꺼내 <strong>실제 엔진 API <code>SpawnActor</code>를 호출</strong>한다. 자연어가 비로소 진짜 액터가 되는 곳.</p>
</div>

<div class="code-block"><span class="code-lang">③ C++ 핸들러 — UnrealMCPEditorCommands.cpp</span><span class="cm">// JSON 필드를 꺼낸다</span>
<span class="ty">FString</span> ActorType;
Params-&gt;TryGetStringField(<span class="fn">TEXT</span>(<span class="str">"type"</span>), ActorType);   <span class="cm">// "STATICMESHACTOR"</span>
<span class="cm">// name, location, rotation, scale 도 같은 식으로 파싱…</span>

<span class="cm">// 에디터 월드를 얻어 실제로 스폰한다</span>
<span class="ty">UWorld</span>* World = GEditor-&gt;GetEditorWorldContext().World();
NewActor = World-&gt;SpawnActor&lt;<span class="ty">AStaticMeshActor</span>&gt;(
    <span class="ty">AStaticMeshActor</span>::StaticClass(), Location, Rotation, SpawnParams);
NewActor-&gt;SetActorTransform(Transform);   <span class="cm">// 스케일은 별도 적용</span></div>

<div class="step-block s2">
<h4>④ 되돌아오는 것 — result(JSON)</h4>
<p>핸들러가 성공/실패와 생성된 액터 정보를 JSON으로 되돌리고, 파이썬 서버가 그것을 MCP <code>result</code>의 <code>content</code> 배열로 포장해 클로드에게 반환한다. 클로드는 이걸 읽고 "큐브 0번 생성 완료"라 보고하거나 다음 큐브로 넘어간다.</p>
</div>

<div class="code-block"><span class="code-lang">④ MCP result · 파이썬 서버 → Claude</span>{
  <span class="str">"result"</span>: {
    <span class="str">"content"</span>: [
      { <span class="str">"type"</span>: <span class="str">"text"</span>,
        <span class="str">"text"</span>: <span class="str">"Spawned StaticMeshActor 'Cube_0' at (0,0,100)"</span> }
    ]
  }
}</div>

<div class="callout callout-teal">
<div class="callout-title">한눈에 — 번역의 사슬</div>
<p><strong>자연어</strong> → ① <strong>MCP 도구 호출</strong>(인자만 채운 JSON) → ② <strong>TCP 명령</strong>(JSON) → ③ <strong>C++ 파싱 + <code>SpawnActor</code></strong> → ④ <strong>result</strong>(JSON) → 다시 자연어. 클로드가 "던지는" 것은 ①의 도구 호출뿐이고, "적절히 액터를 만드는" 지능은 전부 ③의 플러그인 코드에 들어 있다. 모델은 <em>무엇을 할지</em>(인자)를 정하고, 플러그인은 <em>어떻게 할지</em>(엔진 API)를 안다.</p>
</div>

<div class="callout callout-warn">
<div class="callout-title">사소하지만 헷갈리는 디테일</div>
<p>봉투에도 <code>"type"</code>, 그 안 params에도 <code>"type"</code>이 있다. 바깥 <code>type</code>은 <strong>명령 종류</strong>(<code>spawn_actor</code>)라 디스패처가 보고, 안쪽 <code>type</code>은 <strong>액터 클래스</strong>(<code>STATICMESHACTOR</code>)라 핸들러가 본다. 같은 이름이지만 층위가 다르다.</p>
</div>

<p>
주목할 점: <strong>모델은 언리얼을 전혀 모른다.</strong> 모델이 아는 건 "이런 이름과 스키마의 도구가 있다"뿐이고, 그 도구 뒤에서 TCP가 흐르고 C++가 엔진을 만지는 건 전부 서버 구현의 책임이다. 같은 모델이 GitHub 서버를 쓸 때와 정확히 같은 메커니즘으로 언리얼을 쓴다. 이것이 표준화의 힘이다.
</p>

<span class="section-eyebrow">08 — 한계와 보안</span>
</div>

# 빼놓을 수 없는 한계와 보안

<div class="mcp-post">
<p>
멋진 만큼 위험하다. AI에게 에디터 조작 권한을 주는 순간, AI를 향한 공격이 곧 <strong>내 프로젝트를 향한 공격</strong>이 된다. MCP 생태계 전반에서 보고된 위험이 언리얼 연동에 그대로 적용된다.
</p>

<div class="card-grid">
<div class="card coral">
<div class="card-label">위험 1</div>
<div class="card-title">프롬프트 인젝션</div>
<div class="card-desc">에셋 이름·외부 문서·툴 설명에 숨긴 악성 지시가 모델을 오작동시킨다. OWASP LLM Top 10 2025의 <strong>1위 취약점</strong>. MCP 환경에선 단순 챗봇보다 파급이 크다.</div>
</div>
<div class="card gold">
<div class="card-label">위험 2</div>
<div class="card-title">임의 코드 실행</div>
<div class="card-desc"><code>execute_python</code>류 도구는 본질적으로 임의 코드 실행이다. 입력 검증이 없으면 명령 주입으로 이어진다. MCP Inspector의 <strong>CVE-2025-49596(CVSS 9.4)</strong>가 실제 사례.</div>
</div>
<div class="card purple">
<div class="card-label">위험 3</div>
<div class="card-title">툴 포이즈닝</div>
<div class="card-desc">설치 시점엔 안전해 보이던 도구가 <strong>이후 정의를 바꿔치기</strong>한다. 1일차에 승인한 도구가 7일차엔 키를 빼돌릴 수 있다. 신뢰가 시간에 따라 무너진다.</div>
</div>
<div class="card blue">
<div class="card-label">위험 4</div>
<div class="card-title">인증 없는 로컬 소켓</div>
<div class="card-desc">에디터 플러그인의 TCP 서버는 보통 <strong>로컬·무인증</strong>이다. 같은 머신의 다른 프로세스가 그 포트로 명령을 밀어 넣을 여지가 있다.</div>
</div>
</div>

<div class="callout callout-coral">
<div class="callout-title">실제로 일어난 일</div>
<p>2025년 중반, Supabase의 Cursor 에이전트가 <strong>권한이 큰 service-role</strong>로 동작하던 중 사용자 입력이 섞인 지원 티켓을 명령처럼 처리했다. 공격자는 티켓에 SQL을 심어 통합 토큰을 읽고, 그것을 공개 스레드로 유출시켰다. "AI가 신뢰 경계를 넘는" 전형적 패턴이다.</p>
</div>

<h2>현실적인 한계</h2>

<div class="mtable">
<table>
<thead>
<tr><th>구분</th><th>실상</th></tr>
</thead>
<tbody>
<tr><td><strong>성숙도</strong></td><td>대표 구현들이 스스로 <em>experimental</em>이라 명시. API·기능이 크게 바뀔 수 있다.</td></tr>
<tr><td><strong>버전 의존</strong></td><td>UE 5.5+, Python 3.12+ 등 환경 요구가 까다롭고, 엔진 버전에 민감하다.</td></tr>
<tr><td><strong>결정성</strong></td><td>LLM이 도구 호출을 직접 만들기에, 같은 지시도 매번 같은 결과를 보장하지 않는다.</td></tr>
<tr><td><strong>신뢰</strong></td><td>잘 모르는 MCP 서버를 붙이는 건 잘 모르는 실행 파일을 받는 것과 같다. 출처 확인이 필수.</td></tr>
</tbody>
</table>
</div>

<div class="callout callout-info">
<div class="callout-title">실무 권고</div>
<p>① <strong>실험·개인 프로젝트</strong>에서 먼저 쓰고, 중요한 작업물이 든 프로젝트엔 신중하게. ② 서버 코드를 직접 읽거나 신뢰할 수 있는 출처만. ③ 권한은 최소로 — 임의 코드 실행 도구는 꼭 필요할 때만. ④ 버전 관리(git)로 AI의 변경을 항상 되돌릴 수 있게.</p>
</div>

<span class="section-eyebrow">09 — 정리</span>
</div>

# 정리

<div class="mcp-post">
<p>
Unreal MCP는 <strong>"AI ↔ 도구"를 표준화한 MCP 위에, 언리얼 에디터를 조종하는 서버 하나를 올린 것</strong>이다. 화려한 데모 뒤의 구조는 의외로 명료하다.
</p>

<div class="card-grid">
<div class="card purple">
<div class="card-title">프로토콜 — MCP</div>
<div class="card-desc">Host·Client·Server 삼분 구조, JSON-RPC 2.0 데이터 레이어, stdio·Streamable HTTP 전송. tools·resources·prompts를 <code>initialize → list → call</code>로 주고받는다. LSP의 발상을 AI로 옮긴 USB-C.</div>
</div>
<div class="card teal">
<div class="card-title">다리 — Python + 플러그인</div>
<div class="card-desc">AI 앱 ↔ 파이썬 MCP 서버는 <strong>MCP(stdio)</strong>로, 파이썬 서버 ↔ 언리얼 C++ 플러그인은 <strong>로컬 TCP</strong>로. MCP 말하기는 파이썬이, 엔진 만지기는 플러그인이.</div>
</div>
<div class="card coral">
<div class="card-title">대가 — 신뢰의 위임</div>
<div class="card-desc">자연어 한 줄의 편의는 곧 AI에게 에디터 권한을 넘기는 일. 프롬프트 인젝션·임의 코드 실행·무인증 소켓은 옵션이 아니라 기본 위험이다.</div>
</div>
</div>

<p>
그래서 "Claude나 ChatGPT가 어떻게 언리얼을 조작하느냐"의 답은 이렇다 — <strong>모델은 언리얼을 모른 채 표준 도구를 호출할 뿐이고, 그 도구 뒤에서 파이썬과 C++ 플러그인이 TCP로 손을 맞잡아 엔진을 움직인다.</strong> 그리고 여기서 한 발 물러나면 더 큰 그림이 보인다. 같은 소켓 패턴이 이미 GitHub·Slack·DB·Figma를 AI에 잇고 있고, Anthropic이 만든 이 표준을 <strong>OpenAI와 Google까지 채택</strong>했다. 에디터를 GitHub로 바꿔도, 모델을 바꿔도 메커니즘은 동일하다.
</p>

<div class="finale">
<p class="finale-big">
MCP가 중요한 이유는 <em>언리얼을 조작해서</em>가 아니다.<br>
<em>AI가 앞으로 모든 개발 도구와 대화하는 공통 언어</em>가<br>될 가능성이 높기 때문이다.
</p>
<p class="finale-sub">
"언리얼을 조작하는 AI"는 그 공통 언어가 만들어 낸 <strong>수많은 응용 중 하나</strong>일 뿐이다. 오늘은 액터를 스폰하지만, 같은 규격 위에서 내일은 빌드를 돌리고 버그를 추적하고 에셋을 정리한다. MCP의 진짜 성과는 특정 기능이 아니라, AI를 도구에 잇는 일을 <strong>더 이상 특별하지 않게 만든 표준</strong> 그 자체다.
</p>
</div>

</div>

---

<div class="mcp-post">
<p style="font-size:12px;color:var(--text3);">
<strong>참고 출처</strong> ·
<a href="https://www.anthropic.com/news/model-context-protocol">Anthropic — Introducing the Model Context Protocol</a> ·
<a href="https://modelcontextprotocol.io/docs/learn/architecture">modelcontextprotocol.io — Architecture overview</a> ·
<a href="https://en.wikipedia.org/wiki/Model_Context_Protocol">Wikipedia — Model Context Protocol</a> ·
<a href="https://openai.github.io/openai-agents-python/mcp/">OpenAI Agents SDK — MCP</a> ·
<a href="https://github.com/chongdashu/unreal-mcp">github.com/chongdashu/unreal-mcp</a> ·
<a href="https://github.com/kvick-games/UnrealMCP">github.com/kvick-games/UnrealMCP</a> ·
<a href="https://github.com/flopperam/unreal-engine-mcp">github.com/flopperam/unreal-engine-mcp</a> ·
<a href="https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/">Simon Willison — MCP prompt injection</a>
</p>
</div>
