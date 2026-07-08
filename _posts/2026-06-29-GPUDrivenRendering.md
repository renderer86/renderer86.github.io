---
layout: post
title: "GPU-Driven 렌더링: 무엇을 그릴지 CPU가 아니라 GPU가 정하게 하다"
icon: paper
permalink: gpudriven
categories: Rendering
tags: [Rendering, GraphicsProgramming, GPUDriven, IndirectDraw, GPUCulling, UnrealEngine, Nanite]
excerpt: "왜 전통적인 CPU-driven 렌더링이 '드로우콜 제출'에서 막히는지, indirect draw(ExecuteIndirect·vkCmdDrawIndirectCount)가 드로우 인자를 GPU 버퍼로 옮겨 어떻게 그 벽을 허무는지, GPU 컬링(frustum·2-pass HZB occlusion)과 persistent scene buffer·visibility buffer가 그 위에서 어떻게 동작하는지 — 마지막으로 UE5가 FGPUScene·InstanceCulling.usf·FMeshDrawCommand로 이걸 실제로 구현하는 코드까지. mesh shader·Nanite·async compute 글을 묶는 상위 글이다."
back_color: "#ffffff"
img_name: "gpudriven.webp"
toc: false
show: true
new: true
series: -1
---
>
> **이런 분이 읽으면 좋습니다!**
>
> - "드로우콜이 많으면 느리다"는 말은 들었지만, *왜* CPU가 병목이 되는지 한 단계 더 들어가고 싶은 분
> - `DrawIndexedInstanced`까지는 알지만 `ExecuteIndirect` / `vkCmdDrawIndirectCount`가 정확히 뭘 바꾸는지 궁금한 분
> - GPU 컬링·HZB 2-pass occlusion·visibility buffer가 서로 어떻게 맞물리는지 큰 그림으로 정리하고 싶은 분
> - UE5의 `FGPUScene` / `InstanceCulling.usf` / `FMeshDrawCommand`가 실제로 어떤 데이터 흐름인지 코드로 보고 싶은 분
> - mesh shader·Nanite·async compute가 결국 *하나의 흐름(GPU-driven)* 위에 있다는 걸 엮어서 보고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - 드로우콜 1개의 진짜 비용 — 커맨드 버퍼 생성·상태 변경·RHI 스레드, 그리고 "프레임당 수백~수천 드로우" 한계의 출처
> - Indirect Draw의 핵심: 드로우 인자(개수 포함)를 GPU 버퍼에 두고 GPU가 직접 채운다
> - `ExecuteIndirect` + command signature, `vkCmdDrawIndirectCount` + count buffer의 동작
> - GPU 컬링: 컴퓨트 한 번으로 frustum 컬링, 그리고 2-pass occlusion culling + HZB
> - Persistent GPU scene buffer와 bindless가 왜 GPU-driven의 전제 조건인가
> - Visibility Buffer — 픽셀당 4바이트로 G-buffer를 대체하는 발상
> - UE5 실제 코드: `FGPUScene` 업로드 → `InstanceCulling.usf`의 원자적 카운터 → `FRHIDrawIndexedIndirectParameters` → D3D12 `ExecuteIndirect`
> - 이 글이 mesh shader·Nanite·software raster·async compute 글과 어떻게 이어지는가

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
.gd-post {
  --bg2: #eef6f5;
  --bg3: #e6f0ef;
  --surface: #f7fbfa;
  --surface2: #e9f2f1;
  --border: rgba(13,148,136,0.12);
  --border2: rgba(13,148,136,0.26);
  --text: #14201e;
  --text2: #3f4d4a;
  --text3: #7d908c;
  --accent: #0d9488;
  --accent2: #6366f1;
  --gold: #b07d00;
  --teal: #0a8f72;
  --coral: #d6304a;
  --orange: #c85a00;
}
.gd-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.gd-post p { color: var(--text2); line-height: 1.85; }
.gd-post strong { color: var(--text); }
.gd-post .lead { color: var(--text2); line-height: 1.9; }
.gd-post .card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin: 24px 0;
}
.gd-post .card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.gd-post .card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
}
.gd-post .card.blue::before   { background: var(--accent2); }
.gd-post .card.gold::before   { background: var(--gold); }
.gd-post .card.teal::before   { background: var(--accent); }
.gd-post .card.coral::before  { background: var(--coral); }
.gd-post .card.purple::before { background: var(--accent2); }
.gd-post .card.orange::before { background: var(--orange); }
.gd-post .card-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.gd-post .card.blue   .card-label { color: var(--accent2); }
.gd-post .card.gold   .card-label { color: var(--gold); }
.gd-post .card.teal   .card-label { color: var(--accent); }
.gd-post .card.coral  .card-label { color: var(--coral); }
.gd-post .card.purple .card-label { color: var(--accent2); }
.gd-post .card.orange .card-label { color: var(--orange); }
.gd-post .card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}
.gd-post .card-desc {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.65;
  margin: 0;
}
.gd-post .callout {
  border-radius: 12px;
  padding: 16px 20px;
  margin: 20px 0;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.gd-post .callout::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}
.gd-post .callout-info { background: rgba(13,148,136,0.05); border-color: rgba(13,148,136,0.18); }
.gd-post .callout-info::before { background: var(--accent); }
.gd-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); }
.gd-post .callout-warn::before { background: var(--gold); }
.gd-post .callout-teal { background: rgba(10,143,114,0.05); border-color: rgba(10,143,114,0.20); }
.gd-post .callout-teal::before { background: var(--teal); }
.gd-post .callout-purple { background: rgba(99,102,241,0.05); border-color: rgba(99,102,241,0.20); }
.gd-post .callout-purple::before { background: var(--accent2); }
.gd-post .callout-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.gd-post .callout-info .callout-title { color: var(--accent); }
.gd-post .callout-warn .callout-title { color: var(--gold); }
.gd-post .callout-teal .callout-title { color: var(--teal); }
.gd-post .callout-purple .callout-title { color: var(--accent2); }
.gd-post .callout p { margin: 0; font-size: 13px; color: var(--text2); line-height: 1.75; }
.gd-post .callout p + p { margin-top: 10px; }
.gd-post .code-block {
  background: #16201e;
  border: 1px solid rgba(80,180,160,0.15);
  border-radius: 12px;
  padding: 20px 22px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  line-height: 1.85;
  overflow-x: auto;
  margin: 18px 0;
  position: relative;
  white-space: pre;
  color: #cbe5de;
}
.gd-post .code-block .kw  { color: #5eead4; }
.gd-post .code-block .fn  { color: #34d399; }
.gd-post .code-block .cm  { color: #5a7068; font-style: italic; }
.gd-post .code-block .num { color: #fb923c; }
.gd-post .code-block .str { color: #fbbf24; }
.gd-post .code-block .ty  { color: #38bdf8; }
.gd-post .code-lang {
  position: absolute;
  top: 10px; right: 14px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #5a7068;
}
.gd-post .flow-row {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin: 24px 0;
  overflow-x: auto;
}
.gd-post .flow-step {
  flex: 1;
  min-width: 124px;
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 12px 12px;
  position: relative;
  text-align: center;
}
.gd-post .flow-step.cpu { background: rgba(214,48,74,0.06); border-color: rgba(214,48,74,0.28); }
.gd-post .flow-step.gpu { background: rgba(13,148,136,0.07); border-color: rgba(13,148,136,0.30); }
.gd-post .flow-step .step-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: var(--text3);
  margin-bottom: 4px;
}
.gd-post .flow-step .step-name {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}
.gd-post .flow-step .step-desc {
  font-size: 10.5px;
  color: var(--text2);
  line-height: 1.45;
}
.gd-post .flow-arrow {
  display: flex;
  align-items: center;
  padding: 0 5px;
  color: var(--text3);
  font-size: 16px;
  flex-shrink: 0;
}
.gd-post .step-block {
  border-left: 3px solid var(--border2);
  padding: 16px 20px;
  margin: 16px 0;
  background: var(--surface);
  border-radius: 0 10px 10px 0;
}
.gd-post .step-block.s1 { border-color: var(--coral); }
.gd-post .step-block.s2 { border-color: var(--gold); }
.gd-post .step-block.s3 { border-color: var(--accent); }
.gd-post .step-block.s4 { border-color: var(--accent2); }
.gd-post .step-block h4 {
  font-size: 14px;
  font-weight: 700;
  margin: 0 0 6px 0;
}
.gd-post .step-block.s1 h4 { color: var(--coral); }
.gd-post .step-block.s2 h4 { color: var(--gold); }
.gd-post .step-block.s3 h4 { color: var(--accent); }
.gd-post .step-block.s4 h4 { color: var(--accent2); }
.gd-post .step-block p {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.75;
  margin: 0 0 8px 0;
}
.gd-post .step-block p:last-child { margin-bottom: 0; }
.gd-post .legend {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text2);
  margin: 8px 0 0;
}
.gd-post .legend .dot { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
.gd-post .legend .dot.cpu { background: var(--coral); }
.gd-post .legend .dot.gpu { background: var(--accent); }
.gd-post table.cmp { width: 100%; border-collapse: collapse; font-size: 13px; margin: 20px 0; }
.gd-post table.cmp th {
  padding: 10px 14px; border: 1px solid var(--border);
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left;
  background: var(--surface2); color: var(--text3);
}
.gd-post table.cmp th.t { color: var(--coral); }
.gd-post table.cmp th.m { color: var(--accent); }
.gd-post table.cmp td { padding: 9px 14px; border: 1px solid var(--border); color: var(--text2); vertical-align: top; }
.gd-post table.cmp tr:nth-child(even) td { background: var(--surface); }
.gd-post .pillrow { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; }
.gd-post .pill {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11.5px;
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--border2);
  background: var(--surface);
  color: var(--accent);
}
.gd-post .ref-list { list-style: none; padding-left: 0; margin: 16px 0; }
.gd-post .ref-list li { font-size: 13px; color: var(--text2); line-height: 1.7; padding: 7px 0; border-bottom: 1px solid var(--border); }
.gd-post .ref-list li:last-child { border-bottom: none; }
.gd-post .ref-list .ref-tag { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--accent2); font-weight: 600; }
.gd-post .seealso { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin: 18px 0; }
.gd-post .seealso a {
  display: block; padding: 12px 14px; border-radius: 10px;
  background: var(--surface); border: 1px solid var(--border2);
  text-decoration: none; color: var(--text);
}
.gd-post .seealso a .sa-k { display:block; font-family:'JetBrains Mono',monospace; font-size:10.5px; color: var(--accent); margin-bottom: 3px; }
.gd-post .seealso a .sa-t { font-size: 13px; font-weight: 700; }
</style>

<div class="gd-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# GPU-Driven 렌더링이 푸는 문제

<div class="gd-post">
<p class="lead">
그래픽스 파이프라인은 오래도록 <strong>"CPU가 무엇을 그릴지 정해서, 한 번에 하나씩 GPU에 명령한다"</strong>는 전제 위에 있었다. CPU가 "이 메시를, 이 셰이더로, 이 텍스처로 그려라"를 드로우콜 하나하나로 GPU에 불러준다. 장면이 단순할 땐 문제가 없다. 그런데 화면에 그릴 오브젝트가 수만 개로 늘어나면 — GPU는 멀쩡한데 <strong>그 명령을 불러주는 CPU가 먼저 지친다.</strong> GPU-driven 렌더링은 바로 이 구도를 뒤집는다. <strong>"무엇을·몇 개를 그릴지"라는 결정 자체를 CPU에서 떼어내 GPU 안으로 옮긴다.</strong>
</p>

<div class="callout callout-purple">
<div class="callout-title">한 줄로: GPU-driven이 푸는 문제</div>
<p>전통 방식에선 오브젝트 1개를 그릴 때마다 CPU가 "이거 그려" 하고 GPU에게 <strong>명령을 한 번씩 call한다(드로우콜)</strong>. 오브젝트가 5만 개면 call도 5만 번이다. CPU가 이 5만 번을 부르는 동안, 정작 GPU는 명령이 도착하기만 기다리며 놀고 있다. 게다가 그 5만 개 중 화면에 안 보이는 것까지 CPU는 <strong>일단 전부 call한다</strong> — 보이는지 아닌지는 GPU만 정확히 아는데도.</p>
<p>GPU-driven은 <strong>장면 전체를 GPU 메모리에 통째로 올려두고</strong>, "무엇이 보이고, 그래서 무엇을 몇 개 그려야 하는지"를 <strong>GPU가 스스로 계산해 드로우 명령 목록을 직접 쓰게</strong> 한다. CPU는 "그 목록대로 알아서 그려" 한 마디(=한 번의 indirect 호출)만 하면 된다. <strong>"오브젝트마다 call 한 번" → "장면 전체에 call 한 번"</strong>, 이 전환이 GPU-driven의 핵심이다.</p>
</div>

<div class="callout callout-info">
<div class="callout-title">이 글의 흐름</div>
<p>① 전통 CPU-driven 파이프라인이 왜 드로우콜 '제출'에서 막히는가 → ② Indirect Draw — 드로우 인자를 GPU 버퍼로 옮기는 한 수 → ③ GPU 컬링(frustum·2-pass HZB occlusion) → ④ persistent scene buffer·bindless라는 전제 조건 → ⑤ Visibility Buffer → ⑥ UE5의 실제 구현(<code>FGPUScene</code>·<code>InstanceCulling.usf</code>·<code>FMeshDrawCommand</code>) → ⑦ Nanite·mesh shader와의 관계. 앞 단계가 다음 단계의 <em>동기</em>가 되도록 쌓아 올린다.</p>
</div>

<p>
이 블로그에는 이미 <a href="/meshshader">Mesh Shader</a>, <a href="/nanite">Nanite</a>, <a href="/swraster">Software Rasterizer</a>, <a href="/asynccompute">Async Compute</a> 글이 있다. 사실 그 글들은 전부 <strong>"GPU-driven"이라는 하나의 큰 흐름</strong>의 부분들이다. 이 글은 그 부분들을 묶는 <strong>지도(map)</strong> 역할을 한다.
</p>

<span class="section-eyebrow">01 — 전통 파이프라인</span>
</div>

# CPU-driven: 드로우콜 1개의 진짜 비용

<div class="gd-post">
<p>
"드로우콜이 많으면 느리다"는 격언은 누구나 안다. 하지만 <strong>왜</strong> 느린지는 한 단계 더 들어가야 보인다. <code>DrawIndexedInstanced(...)</code> 한 줄은 GPU에 바로 가지 않는다. 그 앞에 긴 CPU 작업이 깔려 있다.
</p>

<div class="flow-row">
<div class="flow-step cpu"><div class="step-num">CPU</div><div class="step-name">상태 설정</div><div class="step-desc">PSO·셰이더·텍스처·버퍼 바인딩</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step cpu"><div class="step-num">CPU</div><div class="step-name">검증</div><div class="step-desc">드라이버/API가 인자 유효성 검사</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step cpu"><div class="step-num">CPU</div><div class="step-name">커맨드 기록</div><div class="step-desc">커맨드 버퍼에 명령 직렬화</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step cpu"><div class="step-num">CPU(RHI)</div><div class="step-name">제출</div><div class="step-desc">큐에 커맨드 리스트 submit</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step gpu"><div class="step-num">GPU</div><div class="step-name">실제 그리기</div><div class="step-desc">여기서야 정점/픽셀 처리</div></div>
</div>
<p class="legend"><span><span class="dot cpu"></span>CPU가 하는 일(병목)</span><span><span class="dot gpu"></span>GPU가 하는 일</span></p>

<p>
앞쪽 네 칸이 전부 <strong>CPU</strong> 일이다. 오브젝트 하나를 그리려면 보통 그 앞에 <strong>여러 번의 리소스 바인딩</strong>(정점 버퍼·인덱스 버퍼·상수 버퍼·텍스처)이 붙는데, Khronos의 Vulkan 문서는 이걸 정확히 짚는다 — <em>"각 바인딩된 리소스는 커맨드 버퍼 생성(예: <code>vkCmdBindVertexBuffer</code> 호출)과 렌더링 양쪽에서 오버헤드를 가진다."</em> 즉 비용은 그리기 자체가 아니라 <strong>그리기를 준비·기록·제출하는 CPU 측</strong>에 있다.
</p>

<div class="callout callout-warn">
<div class="callout-title">숫자로: "프레임당 수백~수천 드로우"</div>
<p>Epic의 아트 최적화 가이드는 이렇게 적는다 — <em>"가장 강력한 그래픽카드도 과부하된 중앙처리장치(CPU)에 의해 병목이 될 수 있다."</em> 그리고 현실적인 상한선을 못박는다: <strong>"DX11 시대 중급 PC가 16ms 안에 처리할 수 있는 현실적인 드로우콜 수는 수백에서 수천 사이"</strong>였다. 60fps는 프레임당 16.6ms다. 오브젝트가 수만 개인 현대적 장면에서 이 예산은 터무니없이 부족하다.</p>
</div>

<p>
물론 엔진들은 이 벽을 오래 우회해 왔다. <strong>인스턴싱</strong>(같은 메시를 한 드로우콜로 N개), <strong>드로우콜 머지/배칭</strong>, <strong>멀티스레드 커맨드 기록</strong>(DX12/Vulkan), UE의 <strong>RHI 스레드 분리</strong> 등. 하지만 이들은 모두 같은 모델 — <em>"CPU가 드로우 목록을 만든다"</em> — 안에서의 최적화다. 근본 한계는 그대로 남는다: <strong>무엇을 그릴지 결정하는 주체가 CPU이고, 그 결정은 GPU가 가진 정보(깊이 버퍼, 가려짐)를 모른 채 내려진다.</strong>
</p>

<div class="step-block s1">
<h4>한계의 핵심 — 결정과 데이터가 분리돼 있다</h4>
<p>오브젝트가 화면 뒤에 가려졌는지(occlusion)는 <strong>GPU의 깊이 버퍼만이 정확히 안다.</strong> 그런데 "그릴지 말지"는 CPU가 정한다. 그래서 CPU는 보수적으로 <strong>일단 다 제출하고</strong>, 가려진 것은 GPU가 픽셀 단계에서 깊이 테스트로 버린다(overdraw). 결정권자(CPU)와 정보 보유자(GPU)가 분리돼 있다는 것 — 이게 전통 모델의 구조적 약점이다.</p>
</div>

<span class="section-eyebrow">02 — Indirect Draw</span>
</div>

# 첫 번째 수: 드로우 인자를 GPU 버퍼로 옮긴다

<div class="gd-post">
<p>
GPU-driven의 출발점은 의외로 단순한 한 줄의 발상이다: <strong>"드로우콜의 인자(개수·오프셋 등)를 CPU 코드에 적지 말고, GPU 메모리의 버퍼에 적어두자."</strong> 그러면 그 버퍼는 <strong>GPU의 컴퓨트 셰이더가 직접 채울 수 있다.</strong> 이것이 <strong>Indirect Draw</strong>다.
</p>

<p>
일반 드로우콜과 비교해 보자. 일반 드로우는 인자가 <strong>CPU 함수 인자</strong>로 박혀 있다:
</p>

<div class="code-block"><span class="code-lang">CPU / 일반 드로우</span><span class="cm">// 인덱스 개수·인스턴스 수가 CPU 코드에 '상수'로 박혀 있다.</span>
<span class="cm">// 이 숫자를 정하려면 CPU가 미리 다 알고 있어야 한다.</span>
cmdList.<span class="fn">DrawIndexedInstanced</span>(
    indexCount,        <span class="cm">// 몇 개의 인덱스를</span>
    instanceCount,     <span class="cm">// 몇 인스턴스</span>
    startIndex, baseVertex, startInstance);</div>

<p>
Indirect 드로우는 그 인자 묶음을 <strong>버퍼 안의 구조체</strong>로 빼낸다. CPU는 "저 버퍼의 저 오프셋에서 인자를 읽어 그려"라고만 한다:
</p>

<div class="code-block"><span class="code-lang">GPU 버퍼 안의 인자 구조체 (D3D12)</span><span class="cm">// 이 구조체가 'GPU 메모리'에 들어있다. CPU가 값을 모를 수도 있다 —</span>
<span class="cm">// 컴퓨트 셰이더가 컬링 결과로 instanceCount를 채워넣기 때문.</span>
<span class="kw">struct</span> D3D12_DRAW_INDEXED_ARGUMENTS {
    <span class="ty">UINT</span> IndexCountPerInstance;
    <span class="ty">UINT</span> InstanceCount;        <span class="cm">// ← 여기를 GPU가 정한다</span>
    <span class="ty">UINT</span> StartIndexLocation;
    <span class="ty">INT</span>  BaseVertexLocation;
    <span class="ty">UINT</span> StartInstanceLocation;
};

cmdList-><span class="fn">ExecuteIndirect</span>(cmdSignature, maxCount, argBuffer, ...);</div>

<div class="callout callout-info">
<div class="callout-title">D3D12: ExecuteIndirect + Command Signature</div>
<p>D3D12에서 indirect 드로우는 <code>ExecuteIndirect</code>로 한다. 핵심 파트너가 <strong>command signature</strong>다. Microsoft 문서: <em>"command signature는 ExecuteIndirect API에 넘겨진 데이터를 GPU가 <strong>어떻게 해석할지</strong>를 지시한다."</em> <code>CreateCommandSignature</code>에 <code>D3D12_INDIRECT_ARGUMENT_DESC</code> 배열을 주면, 명령 하나에 <strong>여러 동작을 묶을 수도</strong> 있다 — 예: 루트 상수 갱신 + 정점 버퍼 바인딩 + <code>DrawInstanced</code>를 한 커맨드로.</p>
</div>

<p>
그런데 진짜 위력은 <strong>"몇 개를 그릴지"마저 GPU가 정하게</strong> 할 때 나온다. 여기서 <strong>count buffer</strong>가 등장한다.
</p>

<div class="step-block s3">
<h4>Count Buffer — "몇 번 그릴지"를 GPU가 런타임에 결정</h4>
<p>D3D12 <code>ExecuteIndirect</code>는 <em>"실제 수행되는 명령의 개수는 <strong>MaxCommandCount</strong>와, <strong>count buffer에 담긴 32비트 정수</strong> 중 <strong>최솟값</strong>"</em>으로 정해진다. 즉 CPU는 "최대 N개까지 그릴 수 있다"고만 예약하고, <strong>실제 개수는 GPU가 컬링을 끝낸 뒤 count buffer에 써넣는다.</strong></p>
<p>Vulkan에도 똑같은 메커니즘이 있다: <code>vkCmdDrawIndirectCount</code>가 draw 개수를 <strong>별도 GPU 버퍼</strong>에서 읽는다(이 기능은 Vulkan 1.2 코어로 승격돼 사실상 모든 PC 하드웨어에서 동작한다). vkguide의 표현대로 <em>"GPU가 몇 개의 draw indirect 명령을 그릴지 결정하게 해서, 컬링된 draw를 쉽게 제거 — 낭비되는 작업이 없게"</em> 만든다.</p>
</div>

<p>
이 한 수로 무엇이 바뀌는가? CPU는 더 이상 오브젝트마다 draw call 하지 않는다. <strong>컴퓨트 디스패치 한 번 + indirect 드로우 한 번</strong>이면, 5만 개든 50만 개든 GPU가 알아서 컬링하고 알아서 개수를 정해 그린다. 렌더링 부하가 <strong>CPU 제출 한계가 아니라 GPU 컴퓨트 성능에 비례</strong>하게 되는 것 — 이것이 GPU-driven의 본질적 이득이다. (vkguide의 예시에서는 ~25만 드로우콜을 CPU 0.5ms 미만에 제출한다.)
</p>

<span class="section-eyebrow">03 — GPU 컬링</span>
</div>

# 그래서 GPU가 직접 컬링한다: Frustum과 HZB Occlusion

<div class="gd-post">
<p>
드로우 인자 버퍼를 GPU가 채울 수 있게 됐으니, 이제 <strong>"무엇을 그릴지"를 GPU가 직접 고르는</strong> 단계로 간다. 그게 GPU 컬링이다. 컬링은 보통 두 층으로 나뉜다.
</p>

<div class="card-grid">
<div class="card teal">
<div class="card-label">Layer 1</div>
<div class="card-title">Frustum Culling — 시야 밖 버리기</div>
<div class="card-desc">컴퓨트 셰이더 1개 호출에서, 스레드 1개가 오브젝트 1개를 맡는다. 오브젝트의 바운딩 스피어/박스를 카메라 절두체와 테스트해서, 보이면 instanceCount를 1로, 시야 밖이면 0으로 토글한다. 그림자 캐스터 컬링도 같은 방식으로 GPU에서 끝낸다.</div>
</div>
<div class="card blue">
<div class="card-label">Layer 2</div>
<div class="card-title">Occlusion Culling — 가려진 것 버리기</div>
<div class="card-desc">시야 안이어도 다른 오브젝트 뒤에 가려졌으면 그릴 필요가 없다. 가려짐은 깊이 정보가 필요한데, 이건 GPU만 정확히 안다. 그래서 HZB(계층적 깊이 버퍼)를 써서 GPU가 직접 가림 테스트를 한다.</div>
</div>
</div>

<p>
Frustum 컬링의 GPU 구현은 직관적이다. Khronos의 예제 설명: <em>"컴퓨트 셰이더의 각 invocation이 하나의 <code>VkDrawIndexedIndirectCommand</code> 구조체에 대응하고, 바운딩 스피어를 SSBO에서 읽어 온다. 그 모델을 그릴지는 instance count를 0과 1 사이로 토글해 결정한다."</em> 즉 컬링 결과가 곧바로 <strong>indirect 인자 버퍼의 한 칸</strong>에 기록된다.
</p>

<h2 style="font-size:19px;margin-top:34px;color:var(--text);">2-Pass Occlusion Culling — 이전 프레임의 결과를 이번 프레임에 재활용한다</h2>

<p>
Occlusion은 까다롭다. "A가 B를 가리는지" 알려면 이미 깊이 버퍼가 있어야 하는데, 깊이 버퍼는 그리고 나서야 생긴다 — <strong>닭이 먼저냐 달걀이 먼저냐</strong> 문제다. 업계 표준 해법이 <strong>two-pass occlusion culling</strong>이고, 그 골자는 <strong>"이전 프레임에 보였던 것들을 occluder로 재사용"</strong>하는 것이다. (이 기법의 원형은 Ulrich Haar &amp; Sebastian Aaltonen의 SIGGRAPH 2015 발표다.)
</p>

<div class="step-block s2">
<h4>Pass 1 — 이전 프레임에 보였던 것만 그리기</h4>
<p>이전 프레임에 보였던(visible) 오브젝트들만 먼저 그린다. 이들이 이번 프레임의 <strong>occluder 후보</strong>다. 한 기술 블로그의 설명: <em>"첫 패스는 이전 프레임에 보였던 오브젝트만 처리하는 책임을 진다."</em></p>
</div>
<div class="step-block s3">
<h4>HZB 빌드 — 그 깊이로 깊이 피라미드를 만든다</h4>
<p>Pass 1의 깊이 버퍼에서 <strong>HZB(Hierarchical Z-Buffer)</strong>를 만든다. 원본 깊이를 2×2씩 묶어 <strong>가장 먼 값(furthest)으로 다운샘플</strong>하며 mip 체인을 쌓는다. <em>"첫 패스가 끝나면 그 깊이 버퍼로 HZB를 생성할 수 있다. 이는 reprojection으로 근사한 깊이 버퍼와 달리 <strong>완전히 보수적인(conservative)</strong> 접근"</em>이다 — 같은 프레임의 진짜 깊이를 쓰기 때문에 잘못 버릴 위험이 없다.</p>
</div>
<div class="step-block s4">
<h4>Pass 2 — 나머지 전부를 HZB로 가림 테스트</h4>
<p>나머지 오브젝트 전부를 이 HZB에 대고 테스트한다. 오브젝트의 화면 공간 바운딩 사각형이 차지하는 영역에 맞는 mip 레벨을 골라, <strong>그 영역의 가장 먼 깊이보다 오브젝트가 더 멀면 = 가려짐 → 버린다.</strong> 살아남은 것만 indirect 인자 버퍼에 추가된다.</p>
</div>

<div class="callout callout-teal">
<div class="callout-title">핵심: 각 패스는 '컴퓨트 디스패치 1번'</div>
<p>중요한 구현 디테일 하나. <em>"각 패스는 단 하나의 컴퓨트 셰이더 디스패치로 구성되며, 그 목적은 indirect draw call 인자를 채우는 것이다."</em> 즉 컬링 → 인자 버퍼 채우기 → indirect 드로우가 한 줄로 꿰어진다. CPU는 여기에 끼어들지 않는다.</p>
</div>

<p>
왜 mip 피라미드(HZB)가 필요한가? 오브젝트 하나의 가림을 테스트하려고 그 뒤의 깊이 픽셀을 전부 읽으면 너무 비싸다. HZB는 <strong>"이 화면 영역에서 가장 먼 깊이"를 미리 한 텍셀에 요약</strong>해 둔 것이라, 큰 오브젝트는 낮은 해상도 mip의 텍셀 몇 개만 읽고 즉시 판정할 수 있다. (UE5는 furthest와 closest 두 종류의 HZB를 모두 만들어 다양한 컬링에 쓴다.)
</p>

<h2 style="font-size:19px;margin-top:34px;color:var(--text);">왜 하필 이 두 컬링이 GPU-driven과 궁합이 맞나</h2>

<p>
잠깐 짚고 갈 게 있다. frustum 컬링과 2-pass occlusion 컬링은 <strong>그냥 "GPU에서도 돌릴 수 있는" 정도가 아니라, GPU-driven 모델과 구조적으로 딱 맞물린다.</strong> 1장에서 전통 모델의 약점을 <em>"결정권자(CPU)와 정보 보유자(GPU)가 분리돼 있다"</em>고 했는데 — GPU 컬링이 정확히 그 틈을 메운다. 이유는 네 가지다.
</p>

<div class="card-grid">
<div class="card teal">
<div class="card-label">궁합 1</div>
<div class="card-title">출력 모양이 indirect 인자와 똑같다</div>
<div class="card-desc">컬링의 결과물은 "무엇을 몇 개 그릴지" = <code>InstanceCount</code> + 살아남은 인스턴스 목록이다. 이건 그대로 <strong>indirect 인자 버퍼</strong>다. 컬링 컴퓨트와 indirect 드로우가 같은 버퍼를 공유하니 readback·동기화가 없다 — 컬링→인자→드로우가 한 줄로 꿰인다.</div>
</div>
<div class="card blue">
<div class="card-label">궁합 2</div>
<div class="card-title">객체마다 독립 → 완전 병렬</div>
<div class="card-desc">frustum 테스트는 객체 하나를 절두체에 대보는 것뿐, 스레드 간 의존성이 0이다. 스레드 1개=객체 1개로 수만 개를 한 디스패치에 돌리는 건 GPU가 가장 잘하는 일이다. CPU에선 직렬 루프가 된다.</div>
</div>
<div class="card purple">
<div class="card-label">궁합 3</div>
<div class="card-title">occlusion 데이터(깊이)가 GPU에 산다</div>
<div class="card-desc">HZB는 GPU 깊이 버퍼로 만든다. CPU가 가림 컬링을 하려면 깊이를 readback해야 해서 스톨·한 프레임 랙이 생긴다. GPU에서 하면 HZB가 GPU를 떠나지 않는다 — 데이터가 이미 필요한 곳에 있다.</div>
</div>
<div class="card gold">
<div class="card-label">궁합 4</div>
<div class="card-title">CPU 비용을 객체 수와 분리 유지</div>
<div class="card-desc">GPU-driven의 본질이 "CPU 비용 ≠ 객체 수"인데, 컬링을 CPU로 빼면 다시 O(N) CPU 비용이 부활해 목적이 무너진다. GPU 컬링은 500만 개를 걸러도 CPU는 디스패치 한 번이다.</div>
</div>
</div>

<div class="callout callout-info">
<div class="callout-title">한 줄로: 결정을 데이터가 있는 곳에서 내린다</div>
<p>전통 모델은 "무엇을 그릴지"를 <strong>CPU가</strong> 정하는데, 정작 그 판단에 필요한 깊이·가림 정보는 <strong>GPU에</strong> 있었다. 그래서 보수적으로 다 제출하고 뒤에서 버렸다(overdraw). GPU 컬링은 <strong>결정을 데이터가 있는 곳(GPU)으로 옮겨</strong> 이 분리를 없앤다. frustum·occlusion 컬링이 GPU-driven과 "궁합이 맞는" 게 아니라, 사실은 <strong>GPU-driven이 성립하려면 컬링이 GPU로 와야만 했던 것</strong>에 가깝다.</p>
</div>

<span class="section-eyebrow">04 — 전제 조건</span>
</div>

# GPU-driven의 전제: Persistent Scene Buffer와 Bindless

<div class="gd-post">
<p>
여기서 멈춰 생각해 보자. GPU가 컬링을 하려면 <strong>장면의 모든 오브젝트 정보</strong>(변환 행렬, 바운딩 볼륨, 머티리얼 등)를 GPU가 들고 있어야 한다. 컬링 결과로 어떤 메시를 그릴지 정했으면, 그 메시의 정점/인덱스/텍스처에 <strong>CPU 개입 없이 곧장 접근</strong>할 수 있어야 한다. 이 두 가지가 GPU-driven의 숨은 전제 조건이다.
</p>

<div class="card-grid">
<div class="card teal">
<div class="card-label">전제 1</div>
<div class="card-title">Persistent Scene Buffer</div>
<div class="card-desc">오브젝트의 변환·바운드·머티리얼 ID 등을 매 프레임 다시 올리지 않고, GPU에 큰 구조화 버퍼로 상주시킨다. 바뀐 인스턴스만 부분 갱신(scatter upload)한다. GPU 컬링 셰이더는 인스턴스 인덱스로 이 버퍼를 읽어 판정한다.</div>
</div>
<div class="card blue">
<div class="card-label">전제 2</div>
<div class="card-title">Bindless Resources</div>
<div class="card-desc">전통 모델은 드로우 전에 CPU가 텍스처/버퍼를 슬롯에 '바인딩'했다. GPU-driven에선 CPU가 그 타이밍에 없다. 그래서 모든 리소스를 거대한 디스크립터 배열에 올려두고, 셰이더가 인덱스(정수)로 직접 골라 쓴다 — 이게 bindless다.</div>
</div>
</div>

<p>
직관적으로: <strong>예전엔 CPU가 "이번엔 이 텍스처"라고 매번 GPU에 끼워줬다면, 이제는 GPU가 카탈로그에서 번호로 직접 꺼내 쓴다.</strong> 드로우 시점에 CPU가 없으니, 리소스 선택도 GPU의 정수 인덱싱으로 바뀌어야 하는 것이다. 이 두 조각이 갖춰져야 비로소 "GPU가 장면을 보고 스스로 그릴 목록을 만든다"가 성립한다. UE5에서 전제 1을 담당하는 것이 바로 다음 장의 <strong><code>FGPUScene</code></strong>이다.
</p>

<span class="section-eyebrow">05 — Visibility Buffer</span>
</div>

# Visibility Buffer: 픽셀당 4바이트라는 발상

<div class="gd-post">
<p>
GPU-driven과 짝을 이루는 또 하나의 아이디어가 <strong>Visibility Buffer</strong>다. 이건 컬링이 아니라 <strong>"무엇을 G-buffer에 저장할 것인가"</strong>에 관한 재설계다. 전통적인 deferred shading은 G-buffer에 픽셀마다 <strong>알베도·노멀·러프니스·머티리얼 파라미터</strong>를 다 적는다 — 보통 픽셀당 16~32바이트. 메모리 대역폭을 엄청나게 먹는다.
</p>

<p>
Burns &amp; Hunt의 2013년 논문(JCGT)이 던진 질문은 이렇다: <strong>"굳이 픽셀마다 셰이딩 결과를 다 저장해야 하나? 그 픽셀이 '어느 삼각형'인지만 적어두면 나중에 다시 계산할 수 있지 않나?"</strong>
</p>

<table class="cmp">
<thead><tr><th class="t">전통 G-Buffer (deferred)</th><th class="m">Visibility Buffer</th></tr></thead>
<tbody>
<tr><td>픽셀당 알베도·노멀·러프니스 등 <strong>16~32바이트</strong></td><td>픽셀당 <strong>삼각형 인덱스 + 인스턴스 ID</strong>, 단 <strong>4바이트</strong>(큰/테셀레이션 장면도 8바이트)</td></tr>
<tr><td>1080p·8x MSAA에서 <strong>약 398MB</strong></td><td>같은 조건에서 <strong>약 64MB</strong></td></tr>
<tr><td>래스터 단계에서 모든 속성을 미리 계산·저장</td><td>속성 보간·셰이딩을 <strong>나중 컴퓨트 패스로 완전히 지연</strong></td></tr>
</tbody>
</table>

<p>
나중 셰이딩 패스에서는 픽셀의 (삼각형 ID, 인스턴스 ID)로 <strong>① 삼각형 정점을 다시 읽어오고 → ② barycentric 좌표를 재계산하고 → ③ 속성을 보간하고 → ④ BRDF/라이팅을 픽셀 빈도로 실행</strong>한다. 즉 "저장"을 "재계산"으로 바꿔 메모리를 아끼는 트레이드다. 이게 왜 GPU-driven과 짝인가? <strong>삼각형 ID로 정점을 다시 읽으려면, 장면 전체 지오메트리가 GPU에 상주(persistent buffer)하고 bindless로 접근 가능해야</strong> 하기 때문이다. 두 아이디어는 같은 토대를 공유한다.
</p>

<div class="callout callout-purple">
<div class="callout-title">이것이 Nanite로 이어진다</div>
<p>UE5 <strong>Nanite</strong>가 바로 이 구조의 집대성이다. 하드웨어/소프트웨어 래스터라이저가 모두 <strong>64비트 atomic</strong>으로 visibility buffer에 <code>(depth &lt;&lt; 32) | clusterId</code>를 써넣는다 — 깊이 비교와 삼각형 ID 기록을 한 번의 원자적 연산으로 합친 것이다. 셰이딩은 그 ID를 풀어 나중에 한다. 자세한 건 <a href="/nanite">Nanite 글</a>과 <a href="/swraster">Software Rasterizer 글</a> 참고.</p>
</div>

<span class="section-eyebrow">06 — UE5 구현</span>
</div>

# UE5는 이걸 어떻게 구현하나: 코드로 따라가기

<div class="gd-post">
<p>
이제 개념을 UE5 소스(<code>D:\UnrealEngine</code>, 5.7.4 기준)에 대보자. UE5의 GPU-driven 경로는 크게 네 단계의 데이터 흐름이다.
</p>

<div class="flow-row">
<div class="flow-step gpu"><div class="step-num">① 상주</div><div class="step-name">FGPUScene</div><div class="step-desc">장면을 GPU 버퍼로 상주·갱신</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step gpu"><div class="step-num">② 컬링</div><div class="step-name">InstanceCulling.usf</div><div class="step-desc">컴퓨트로 컬링 + 인자 버퍼 작성</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step gpu"><div class="step-num">③ 인자</div><div class="step-name">IndirectArgs</div><div class="step-desc">FRHIDrawIndexedIndirectParameters</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step gpu"><div class="step-num">④ 그리기</div><div class="step-name">ExecuteIndirect</div><div class="step-desc">D3D12 indirect 드로우</div></div>
</div>

<h2 style="font-size:19px;margin-top:34px;color:var(--text);">① FGPUScene — 장면을 GPU에 상주시킨다</h2>

<p>
<code>FGPUScene</code>(<code>Renderer/Private/GPUScene.h</code>)은 4장에서 말한 "전제 1: persistent scene buffer"의 UE5 구현이다. 프리미티브·인스턴스·페이로드·라이트맵 데이터를 각각 RDG 풀 버퍼로 들고, 바뀐 부분만 비동기 scatter 업로드한다.
</p>

<div class="code-block"><span class="code-lang">GPUScene.h (≈339–354)</span><span class="cm">// GPU에 상주하는 장면 버퍼들. 매 프레임 통째로 올리지 않고,</span>
<span class="cm">// FRDGAsyncScatterUploadBuffer로 '바뀐 인스턴스만' 흩뿌려 갱신한다.</span>
<span class="ty">TRefCountPtr</span>&lt;FRDGPooledBuffer&gt; PrimitiveBuffer;          <span class="cm">// 프리미티브(메시 단위)</span>
FRDGAsyncScatterUploadBuffer     PrimitiveUploadBuffer;

<span class="ty">TRefCountPtr</span>&lt;FRDGPooledBuffer&gt; InstanceSceneDataBuffer;   <span class="cm">// 인스턴스별 변환·바운드</span>
FRDGAsyncScatterUploadBuffer     InstanceSceneUploadBuffer;

<span class="ty">TRefCountPtr</span>&lt;FRDGPooledBuffer&gt; InstancePayloadDataBuffer; <span class="cm">// 인스턴스 추가 페이로드</span>
<span class="ty">TRefCountPtr</span>&lt;FRDGPooledBuffer&gt; LightmapDataBuffer;        <span class="cm">// 라이트맵</span></div>

<p>
셰이더 쪽에서는 이 버퍼들이 <code>StructuredBuffer&lt;float4&gt;</code>로 묶여 들어온다(<code>FGPUSceneResourceParameters</code>, <code>GPUScene.h:56</code>). 컬링·렌더링 셰이더는 인스턴스 인덱스로 이걸 읽어 변환과 바운드를 얻는다. 디코드는 <code>SceneData.ush</code>의 <code>GetInstanceSceneData()</code>(<code>SceneData.ush:1322</code>)와 <code>FInstanceSceneData</code> 구조체(<code>SceneData.ush:227</code>)가 담당한다 — 인스턴스의 <code>LocalToWorld</code>, <code>LocalBoundsCenter/Extent</code>, <code>PrimitiveId</code> 등을 풀어준다. 업로드 경로는 <code>FGPUScene::Update()</code>(<code>GPUScene.cpp:1782</code>) → <code>UploadGeneral()</code>이 <code>ParallelForTemplate</code>로 병렬 처리한다.
</p>

<h2 style="font-size:19px;margin-top:34px;color:var(--text);">② InstanceCulling.usf — 컬링하며 인자 버퍼를 채운다</h2>

<p>
컬링과 indirect 인자 작성을 동시에 하는 컴퓨트 셰이더가 <code>InstanceCulling/BuildInstanceDrawCommands.usf</code>의 <code>InstanceCullBuildInstanceIdBufferCS</code>(≈242–365)다. 흐름은 3장에서 본 그대로다 — frustum 테스트(≈162–200) → HZB occlusion 테스트(≈203–226) → 살아남으면 인자 버퍼에 기록.
</p>

<div class="code-block"><span class="code-lang">BuildInstanceDrawCommands.usf — HZB occlusion (≈203–226)</span><span class="cm">// 3장의 2-pass occlusion이 여기 있다. 이전 프레임 변환으로</span>
<span class="cm">// 화면 사각형을 구해 HZB에 대고 가림 테스트.</span>
<span class="kw">if</span> (Cull.bIsVisible &amp;&amp; bAllowOcclusionCulling) {
    FFrustumCullData PrevCull = <span class="fn">BoxCullFrustum</span>(
        LocalBoundsCenter, LocalBoundsExtent,
        DynamicData.PrevLocalToTranslatedWorld,
        NaniteView.PrevTranslatedWorldToClip, ...);
    <span class="kw">if</span> (PrevCull.bIsVisible &amp;&amp; !PrevCull.bCrossesNearPlane) {
        FScreenRect PrevRect = <span class="fn">GetScreenRect</span>(NaniteView.HZBTestViewRect, PrevCull, <span class="num">4</span>);
        Cull.bIsVisible = <span class="fn">IsVisibleHZB</span>(PrevRect, <span class="kw">true</span>);  <span class="cm">// ← GPU 가림 판정</span>
    }
}</div>

<p>
컬링을 통과한 인스턴스는 어떻게 "그릴 목록"이 되는가? <strong>여기가 GPU-driven의 심장</strong>이다. 셰이더는 <strong>원자적 증가(InterlockedAdd)</strong>로 indirect 인자 버퍼의 <code>InstanceCount</code> 필드를 직접 키운다:
</p>

<div class="code-block"><span class="code-lang">BuildInstanceDrawCommands.usf (≈352)</span><span class="cm">// 살아남은 인스턴스가 자기 자리를 '원자적으로' 예약한다.</span>
<span class="cm">// 워드 [1] = InstanceCount. 이게 곧 indirect 드로우의 인스턴스 수가 된다.</span>
<span class="ty">uint</span> OutputOffset;
<span class="fn">InterlockedAdd</span>(
    DrawIndirectArgsBufferOut[Payload.IndirectArgIndex * INDIRECT_ARGS_NUM_WORDS + <span class="num">1</span>],
    <span class="num">1U</span>, OutputOffset);
<span class="fn">WriteInstance</span>(InstanceDataOutputOffset + OutputOffset * INSTANCE_DATA_STRIDE_ELEMENTS, ...);</div>

<p>
컬링 전에는 <code>ClearIndirectArgInstanceCountCS</code>(≈371)가 모든 <code>InstanceCount</code>(워드 1)를 0으로 밀어둔다. 그러면 컬링 패스에서 살아남은 인스턴스 수만큼만 카운트가 올라간다 — <strong>2장에서 말한 "GPU가 그릴 개수를 런타임에 정한다"가 정확히 이 InterlockedAdd 한 줄</strong>이다.
</p>

<h2 style="font-size:19px;margin-top:34px;color:var(--text);">③ IndirectArgs — FRHIDrawIndexedIndirectParameters</h2>

<p>
그 인자 버퍼의 한 칸은 정확히 D3D12의 그것과 같은 5워드 구조다. UE는 이를 <code>FRHIDrawIndexedIndirectParameters</code>(<code>RHI.h:569</code>)로 정의하고, <code>InstanceCullingContext.h:92</code>에서 <code>IndirectArgsNumWords = 5</code>로 못박는다.
</p>

<div class="code-block"><span class="code-lang">RHI.h (≈569–576)</span><span class="kw">struct</span> FRHIDrawIndexedIndirectParameters {
    <span class="ty">uint32</span> IndexCountPerInstance;
    <span class="ty">uint32</span> InstanceCount;        <span class="cm">// ← 워드 1: 컬링 CS가 InterlockedAdd로 채움</span>
    <span class="ty">uint32</span> StartIndexLocation;
    <span class="ty">int32</span>  BaseVertexLocation;
    <span class="ty">uint32</span> StartInstanceLocation;
};</div>

<p>
이 버퍼 자체는 <code>FInstanceCullingContext::BuildRenderingCommands()</code>(<code>InstanceCullingContext.cpp:670~987</code>)가 RDG 버퍼로 만들고(<code>CreateIndirectDesc</code>), <code>AllocateIndirectArgs()</code>(<code>:253</code>)가 드로우 커맨드마다 한 칸씩 <code>InstanceCount = 0</code>으로 예약한다. 컬링 디스패치가 그 0을 채워 넣는 식이다. RDG 의존성도 명시적이다 — <code>FInstanceCullingDrawParams</code>의 <code>DrawIndirectArgsBuffer</code>는 <code>ERHIAccess::IndirectArgs</code>로 선언돼, RDG가 "컬링 패스가 다 쓴 뒤에 드로우 패스가 읽는다"는 배리어를 자동으로 건다.
</p>

<div class="callout callout-info">
<div class="callout-title">FMeshDrawCommand — CPU-driven 베이스라인과의 연결</div>
<p>UE의 드로우 단위는 <code>FMeshDrawCommand</code>(<code>MeshPassProcessor.h:1281</code>)다. 흥미로운 건 이 구조체가 <strong>union</strong>으로 두 모드를 다 품는다는 점 — 일반 드로우용 <code>VertexParams{BaseVertexIndex, NumVertices}</code>와 indirect용 <code>IndirectArgs{Buffer, Offset}</code>. 또 <code>MatchesForDynamicInstancing()</code>(<code>:1333</code>)으로 같은 PSO·바인딩을 쓰는 드로우들을 <strong>하나의 인스턴스 드로우로 머지</strong>한다(1장에서 말한 전통적 우회책). GPU-driven 경로는 이 위에 indirect 인자 버퍼를 얹는 구조다.</p>
</div>

<h2 style="font-size:19px;margin-top:34px;color:var(--text);">④ ExecuteIndirect — RHI/D3D12에서 실제 그리기</h2>

<p>
마지막으로 그 인자 버퍼를 GPU에 "이대로 그려"라고 넘긴다. RHI 추상층에는 <code>DrawIndexedPrimitiveIndirect</code>와 <code>MultiDrawIndexedPrimitiveIndirect</code>가 있다(<code>RHICommandList.h:3921</code>). D3D12 백엔드에서 이는 2장에서 본 <code>ExecuteIndirect</code>로 내려간다.
</p>

<div class="code-block"><span class="code-lang">D3D12Commands.cpp (≈1307–1323)</span><span class="cm">// command signature는 어댑터 초기화 때 한 번 만들어 둔다</span>
<span class="cm">// (D3D12Adapter.cpp:1650, type = DRAW_INDEXED).</span>
<span class="fn">GraphicsCommandList</span>()-><span class="fn">ExecuteIndirect</span>(
    GetParentAdapter()-><span class="fn">GetDrawIndexedIndirectCommandSignature</span>(),
    MaxDrawArguments,                       <span class="cm">// 최대 개수</span>
    ArgumentBufferLocation.GetResource()..., <span class="cm">// 인자 버퍼(GPU가 채운 것)</span>
    CountBufferResource, ...);               <span class="cm">// count 버퍼 → 실제 개수는 GPU가 결정</span>

<span class="cm">// 단일 indirect 드로우는 count=1인 MDI의 특수 케이스로 처리된다:</span>
<span class="kw">void</span> FD3D12CommandContext::<span class="fn">RHIDrawIndexedPrimitiveIndirect</span>(...) {
    <span class="fn">RHIMultiDrawIndexedPrimitiveIndirect</span>(IndexBuffer, ArgBuffer, Offset, <span class="kw">nullptr</span>, <span class="num">0</span>, <span class="num">1</span>);
}</div>

<p>
이렇게 <strong>FGPUScene 상주 → 컴퓨트 컬링이 InterlockedAdd로 인자 작성 → FRHIDrawIndexedIndirectParameters → ExecuteIndirect</strong>로 한 바퀴가 닫힌다. CPU는 컴퓨트 디스패치들과 indirect 드로우를 <em>기록</em>할 뿐, "오브젝트가 5만 개니 5만 번"을 하지 않는다. 1장의 "수백~수천 드로우" 벽이 여기서 무너진다.
</p>

<h2 style="font-size:19px;margin-top:34px;color:var(--text);">⑤ 그럼 실제 메시 버퍼·텍스처는 어디서 넘어가나?</h2>

<p>
여기서 자연스럽게 헷갈리는 지점이 하나 있다. indirect 인자 구조체를 다시 보면 — <strong>버퍼 핸들이 하나도 없다.</strong> <code>IndexCountPerInstance</code>·<code>InstanceCount</code>·<code>StartIndexLocation</code> 같은 <strong>개수와 오프셋뿐</strong>이다. 그런데 GPU는 대체 어느 정점·인덱스·텍스처를 읽어서 그리는 걸까? "instanceCount를 GPU가 정한다"는 말 때문에 <em>"메시 자체도 GPU가 고르나?"</em>로 오해하기 쉬운데, 그렇지 않다.
</p>

<div class="step-block s3">
<h4>정점·인덱스 버퍼 — 여전히 CPU가 바인딩한다</h4>
<p>indirect라고 버퍼까지 GPU가 고르는 게 아니다. 메시의 VB/IB는 <strong>일반 드로우와 똑같이 CPU가 바인딩</strong>하고, indirect 인자는 그 위에 "몇 개를·어디서부터"만 얹는다. UE 코드가 명확하다 — 인덱스 버퍼는 draw command가 직접 들고 넘긴다:</p>
</div>

<div class="code-block"><span class="code-lang">MeshPassProcessor.cpp (≈1362)</span>RHICmdList.<span class="fn">DrawIndexedPrimitiveIndirect</span>(
    MeshDrawCommand.IndexBuffer,      <span class="cm">// ← 메시의 인덱스 버퍼(CPU가 바인딩)</span>
    SceneArgs.IndirectArgsBuffer,     <span class="cm">// ← 컬링이 채운 인자(개수/오프셋만)</span>
    SceneArgs.IndirectArgsByteOffset);</div>

<p>
즉 <strong>indirect 드로우 1번 = 메시 1개</strong>다. 버퍼는 평소처럼 바인딩되고, "인스턴스 몇 개 / 인덱스 어디부터"만 GPU 버퍼에서 읽는다.
</p>

<div class="callout callout-warn">
<div class="callout-title">instanceCount 혼동 풀기</div>
<p>3장에서 든 <code>instanceCount 0/1 토글</code>은 <strong>오브젝트가 하나뿐인 가장 단순한 예시</strong>였다. 실제 UE에서 <strong>draw command는 "메시 1개"가 아니라 "메시 M + 머티리얼/PSO P" 단위</strong>이고, 그 아래 같은 메시 인스턴스가 수백 개 매달릴 수 있다(예: 같은 나무 500그루). 컬링 CS의 <code>InterlockedAdd</code>는 <strong>살아남은 인스턴스 수만큼</strong> 카운트를 키운다 — 500그루 중 200그루가 보이면 <code>InstanceCount = 200</code>이다. 0/1이 아니라 진짜 개수다.</p>
<p>그래서 <strong>서로 다른 메시·머티리얼 = 서로 다른 draw command = 인자 버퍼의 서로 다른 칸</strong>이다. indirect draw가 마법처럼 여러 다른 메시를 한 콜에 그려주는 게 아니라, 각 draw command가 자기 VB/IB/텍스처를 바인딩한다. <code>MultiDrawIndirect</code>는 여러 command의 인자를 한 버퍼에 모아 <em>콜 수</em>만 줄일 뿐이다.</p>
</div>

<div class="step-block s4">
<h4>인스턴스별 변환 행렬 — 정점 버퍼가 아니라 GPU Scene에서</h4>
<p>이게 진짜 트릭이다. 인스턴스마다 다른 transform은 VB에 안 들어있다. 컬링이 만든 <strong>compacted InstanceId 버퍼</strong>가 <strong>인스턴싱 vertex stream</strong>으로 바인딩된다(<code>PrimitiveIdStreamIndex</code> 슬롯):</p>
</div>

<div class="code-block"><span class="code-lang">MeshPassProcessor.cpp (≈1315–1317)</span><span class="cm">// 컬링 결과(살아남은 InstanceId 목록)를 전용 stream 슬롯에 바인딩</span>
<span class="kw">if</span> (PrimitiveIdStreamIndex != -<span class="num">1</span> &amp;&amp; Stream.StreamIndex == PrimitiveIdStreamIndex)
    RHICmdList.<span class="fn">SetStreamSource</span>(Stream.StreamIndex, SceneArgs.PrimitiveIdsBuffer, SceneArgs.PrimitiveIdOffset);</div>

<p>
그러면 GPU 인스턴싱 하드웨어가 <strong>인스턴스마다 InstanceId 하나씩</strong>을 VS에 먹여주고, VS는 그 id로 <code>GetInstanceSceneData(InstanceId)</code>(<code>SceneData.ush:1322</code>)를 호출해 <strong>GPU Scene 구조화 버퍼에서 그 인스턴스의 <code>LocalToWorld</code>·바운드를 직접 읽어온다.</strong>
</p>

<table class="cmp">
<thead><tr><th class="m">데이터</th><th>어디서 오나</th></tr></thead>
<tbody>
<tr><td>메시 정점·인덱스</td><td>draw command가 바인딩한 VB/IB (indirect 인자는 개수/오프셋만 덮어씀)</td></tr>
<tr><td>인스턴스별 transform</td><td><strong>GPU Scene</strong> 버퍼 — VS가 InstanceId stream으로 받은 id로 in-shader fetch</td></tr>
<tr><td>텍스처·머티리얼</td><td>일반 경로: draw command의 <code>ShaderBindings</code>로 바인딩(같은 머티리얼끼리 묶임)</td></tr>
</tbody>
</table>

<div class="callout callout-purple">
<div class="callout-title">"완전 bindless"는 Nanite의 영역</div>
<p>일반 instance-culling 경로는 머티리얼/텍스처를 <strong>draw command 단위로 바인딩</strong>한다(그래서 머티리얼이 다르면 별도 command). 모든 지오메트리를 하나의 통합 버퍼에 넣고, 텍스처를 bindless 인덱스로 풀어 셰이딩을 deferred로 미루는 건 <strong>Nanite</strong>가 한 발 더 나간 형태다 — 7장에서 Nanite를 "극단적 완성형"이라 부르는 이유다.</p>
</div>

<p>
한 줄로: <strong>indirect draw가 GPU로 옮긴 건 "몇 개를·어디서부터 그릴지"뿐이고, 실제 메시 버퍼는 여전히 CPU가 바인딩하며, 인스턴스별 데이터는 InstanceId를 매개로 GPU Scene에서 in-shader로 당겨온다.</strong>
</p>

<span class="section-eyebrow">07 — Nanite·Mesh Shader와의 관계</span>
</div>

# 이 글이 다른 글들과 만나는 지점

<div class="gd-post">
<p>
GPU-driven은 <strong>하나의 기법이 아니라 하나의 사고방식</strong>이다. 이 블로그의 다른 글들은 그 사고방식의 서로 다른 측면이다.
</p>

<div class="step-block s3">
<h4>Nanite = GPU-driven의 극단적 완성형</h4>
<p>Nanite는 일반 InstanceCulling 경로보다 한 층 더 들어간다. 메시를 <strong>128삼각형 클러스터</strong>로 쪼개, 클러스터 단위로 frustum·2-pass HZB occlusion을 GPU에서 돌리고, LOD까지 GPU가 고른다. UWA4D의 정리대로 Nanite는 <em>"정점 처리 = GPU-Driven Pipeline, 픽셀 처리 = Visibility Buffer + 소프트웨어 래스터"</em>로 나뉜다. 단, 한 가지 차이 — 일반 2-pass는 "이전 프레임에 보인 오브젝트를 다시 그려" occluder를 만들지만, <strong>Nanite는 동적 LOD·스트리밍 때문에 그 목록을 믿을 수 없어 이전 프레임의 HZB를 직접 재사용</strong>한다. → <a href="/nanite">Nanite 글</a></p>
</div>
<div class="step-block s4">
<h4>Mesh Shader = GPU-driven의 지오메트리 프론트엔드 판</h4>
<p>2~3장에서 본 "컴퓨트가 indirect 인자를 채운다"를 <strong>지오메트리 단계 전체로 확장</strong>한 게 mesh/amplification shader다. <code>ExecuteIndirect(DISPATCH_MESH)</code>로 GPU-driven과 곧장 합쳐진다. → <a href="/meshshader">Mesh Shader 글</a></p>
</div>
<div class="step-block s1">
<h4>Software Rasterizer & Async Compute</h4>
<p>Nanite의 작은 삼각형은 하드웨어 래스터보다 컴퓨트 소프트웨어 래스터가 ~3배 빠르다(픽셀 크기 삼각형 한정). 그리고 이 모든 GPU 컬링·래스터 컴퓨트 패스는 그래픽스 큐와 <strong>async compute</strong>로 겹쳐 돌릴 수 있다. → <a href="/swraster">Software Rasterizer 글</a> · <a href="/asynccompute">Async Compute 글</a></p>
</div>

<span class="section-eyebrow">08 — 정리</span>
</div>

# 정리: 결정권은 CPU에서 GPU로 향한다

<div class="gd-post">
<p>
이 글의 단계들은 전부 <strong>한 방향</strong>을 가리킨다 — <strong>"무엇을 그릴지에 대한 결정권을 CPU에서 GPU로 옮긴다."</strong> 각 단계는 그 방향으로 한 걸음씩 더 나아간 것이다.
</p>

<div class="step-block s1">
<h4>① CPU-driven의 벽</h4>
<p>드로우콜마다 CPU가 상태 설정·검증·기록·제출을 한다. 결정권(CPU)과 정보(GPU 깊이)가 분리돼 있어, 가려진 것까지 보수적으로 다 제출한다. DX11 시대엔 프레임당 수백~수천 드로우가 현실적 한계였다.</p>
</div>
<div class="step-block s2">
<h4>② Indirect Draw</h4>
<p>드로우 인자(개수 포함)를 GPU 버퍼로 옮긴다. <code>ExecuteIndirect</code>+command signature, <code>vkCmdDrawIndirectCount</code>+count buffer로 <strong>"몇 개를 그릴지"마저 GPU가 런타임에 정한다.</strong></p>
</div>
<div class="step-block s3">
<h4>③ GPU 컬링 + 전제 조건</h4>
<p>컴퓨트가 frustum·2-pass HZB occlusion을 돌려 살아남은 것만 인자 버퍼에 적는다. 이게 성립하려면 장면이 GPU에 상주(persistent buffer)하고 리소스가 bindless여야 한다.</p>
</div>
<div class="step-block s4">
<h4>④ UE5의 실현 + Visibility Buffer</h4>
<p><code>FGPUScene</code>이 장면을 상주시키고, <code>InstanceCulling.usf</code>가 <code>InterlockedAdd</code>로 <code>FRHIDrawIndexedIndirectParameters</code>를 채워 <code>ExecuteIndirect</code>로 그린다. Visibility buffer(픽셀당 4바이트)는 셰이딩까지 지연시켜 이 토대 위에서 Nanite로 꽃핀다.</p>
</div>

<p>
한 문장으로: <strong>전통 파이프라인이 "CPU가 그릴 목록을 만들어 GPU에 먹인다"였다면, GPU-driven은 "GPU가 장면을 보고 그릴 목록을 스스로 만든다"이다.</strong> mesh shader는 그 사고를 지오메트리 프론트엔드로, Nanite는 클러스터 단위 컬링과 visibility buffer로, software raster는 작은 삼각형 처리로 — 각자 한 발씩 더 밀고 나간다. 이 글은 그 공통 토대를 그린 지도였다.
</p>

<div class="seealso">
<a href="/meshshader"><span class="sa-k">관련 글</span><span class="sa-t">Mesh Shader</span></a>
<a href="/nanite"><span class="sa-k">관련 글</span><span class="sa-t">Nanite</span></a>
<a href="/swraster"><span class="sa-k">관련 글</span><span class="sa-t">Software Rasterizer</span></a>
<a href="/asynccompute"><span class="sa-k">관련 글</span><span class="sa-t">Async Compute</span></a>
</div>

<span class="section-eyebrow">참고자료</span>

<ul class="ref-list">
  <li><span class="ref-tag">[1차]</span> Microsoft, <em>"Indirect Drawing and GPU Culling"</em> Direct3D 12 (command signature, <code>ExecuteIndirect</code>, count buffer = min(MaxCommandCount, count), 컴퓨트 컬링이 UAV에 append). <a href="https://learn.microsoft.com/en-us/windows/win32/direct3d12/indirect-drawing-and-gpu-culling-">learn.microsoft.com</a></li>
  <li><span class="ref-tag">[1차]</span> Khronos, <em>"Multi-draw Indirect"</em> Vulkan Samples (바인딩별 커맨드 버퍼 생성 오버헤드, 컴퓨트 invocation 1개=<code>VkDrawIndexedIndirectCommand</code> 1개, instanceCount 0/1 토글). <a href="https://docs.vulkan.org/samples/latest/samples/performance/multi_draw_indirect/README.html">docs.vulkan.org</a></li>
  <li><span class="ref-tag">[1차]</span> C. Burns, W. Hunt, <em>"The Visibility Buffer: A Cache-Friendly Approach to Deferred Shading"</em>, JCGT 2013 (삼각형 ID 4바이트, 1080p/8x에서 64MB vs 398MB, 셰이딩 지연). <a href="https://jcgt.org/published/0002/02/04/paper.pdf">jcgt.org</a></li>
  <li><span class="ref-tag">[실무]</span> vkguide, <em>"Draw Indirect — GPU Driven Rendering"</em> (<code>vkCmdDrawIndirectCount</code>, GPU가 draw 개수 결정, ~25만 드로우콜 &lt;0.5ms). <a href="https://vkguide.dev/docs/gpudriven/draw_indirect/">vkguide.dev</a></li>
  <li><span class="ref-tag">[실무]</span> M. Kruskonja, <em>"Two Pass Occlusion Culling"</em> (pass1=이전 프레임 visible, HZB 빌드, conservative, 각 패스=컴퓨트 디스패치 1개). <a href="https://medium.com/@mil_kru/two-pass-occlusion-culling-4100edcad501">medium.com/@mil_kru</a></li>
  <li><span class="ref-tag">[배경]</span> U. Haar, S. Aaltonen, <em>"GPU-Driven Rendering Pipelines"</em>, SIGGRAPH 2015 (2-pass occlusion + HZB의 원형). <a href="https://advances.realtimerendering.com/s2015/">advances.realtimerendering.com/s2015</a></li>
  <li><span class="ref-tag">[배경]</span> Epic, <em>"Unreal Engine Performance &amp; Art Optimization"</em> (CPU 병목, DX11 시대 프레임당 수백~수천 드로우 한계). <a href="https://unrealartoptimization.github.io/book/pipelines/">unrealartoptimization.github.io</a></li>
  <li><span class="ref-tag">[분석]</span> UWA4D, <em>"Analysis of UE5 Rendering Technology: Nanite"</em> (정점=GPU-Driven Pipeline / 픽셀=Visibility Buffer+SW raster, 작은 삼각형 ~3배). <a href="https://blog.en.uwa4d.com/2022/02/15/analysis-of-ue5-rendering-technology-nanite/">blog.en.uwa4d.com</a> · 보조: <a href="https://www.elopezr.com/a-macro-view-of-nanite/">elopezr.com (A Macro View of Nanite)</a></li>
  <li><span class="ref-tag">[소스]</span> Unreal Engine 5.7.4 — <code>GPUScene.h/.cpp</code>(<code>FGPUScene</code>·버퍼·<code>Update/UploadGeneral</code>), <code>InstanceCulling/InstanceCullingContext.h/.cpp</code>(<code>BuildRenderingCommands</code>·<code>AllocateIndirectArgs</code>·<code>IndirectArgsNumWords=5</code>), <code>BuildInstanceDrawCommands.usf</code>(<code>InstanceCullBuildInstanceIdBufferCS</code>·<code>InterlockedAdd</code>·<code>IsVisibleHZB</code>), <code>RHI.h</code>(<code>FRHIDrawIndexedIndirectParameters</code>), <code>RHICommandList.h</code>(<code>(Multi)DrawIndexedPrimitiveIndirect</code>), <code>D3D12Commands.cpp</code>·<code>D3D12Adapter.cpp</code>(<code>ExecuteIndirect</code>·CommandSignature), <code>SceneData.ush</code>(<code>FInstanceSceneData</code>·<code>GetInstanceSceneData</code>)</li>
</ul>

</div>
