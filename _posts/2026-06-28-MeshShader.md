---

layout: post
title: "Mesh Shader: 고정함수 지오메트리 파이프라인을 컴퓨트로 다시 쓰다"
icon: paper
permalink: meshshader
categories: Rendering
tags: [Rendering, GraphicsProgramming, MeshShader, GPU, UnrealEngine, Nanite]
excerpt: "전통적인 그래픽스 파이프라인(IA→VS→GS→래스터)이 왜 한계에 부딪혔는지, 컴퓨트 셰이더의 Dispatch 모델과 GPU-driven 렌더링이 그 한계를 어떻게 우회했는지, 그리고 그 흐름의 종착점인 Mesh Shader가 지오메트리 프론트엔드를 통째로 컴퓨트로 바꾼 방식 — 마지막으로 UE5 Nanite가 실제로 mesh shader를 쓰는 코드까지"
back_color: "#ffffff"
img_name: "meshshader.webp"
toc: false
show: true
new: true
series: -1
index: 11
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - "Vertex Shader → Pixel Shader" 까지는 알지만, 그 앞단(Input Assembler·Geometry Shader)이 왜 문제였는지 궁금한 분
> - 컴퓨트 셰이더의 `Dispatch`와 `numthreads`가 그래픽스의 `Draw`와 뭐가 다른지 헷갈리는 분
> - GPU-driven 렌더링이 "전통 파이프라인이 어려워서 나온 건가?"라는 의문이 드는 분
> - Mesh Shader / Amplification(Task) Shader가 도대체 뭘 대체하는 건지 한 번에 정리하고 싶은 분
> - UE5 Nanite가 실제로 mesh shader를 어떻게 호출하는지 코드로 보고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - 전통적인 래스터 파이프라인의 단계와 각 단계의 고정함수 병목
> - Geometry Shader가 "쓰지 마라"는 평을 듣게 된 구조적 이유
> - 컴퓨트 셰이더의 Thread Group / `Dispatch(x,y,z)` / `SV_DispatchThreadID` 모델
> - GPU-driven 렌더링과 Indirect Draw(`ExecuteIndirect`)·GPU 컬링의 동기
> - Mesh Shader 파이프라인 — meshlet, `SetMeshOutputCounts`, per-primitive 속성
> - Amplification(Task) Shader의 `DispatchMesh`와 동적 확장/컬링
> - UE5 Nanite의 `HWRasterizeMS` — mesh shader 한 그룹이 클러스터 하나를 그리는 실제 코드

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500\&display=swap" rel="stylesheet">

<style>
.ms-post {
  --bg2: #f3f5fb;
  --bg3: #eceef7;
  --surface: #f9fafd;
  --surface2: #ebedf6;
  --border: rgba(70,80,190,0.10);
  --border2: rgba(70,80,190,0.22);
  --text: #1a1d2e;
  --text2: #454b69;
  --text3: #868eac;
  --accent: #4f6bed;
  --accent2: #8b5cf6;
  --gold: #b07d00;
  --teal: #0a8f72;
  --coral: #d6304a;
  --orange: #c85a00;
}
.ms-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.ms-post p { color: var(--text2); line-height: 1.85; }
.ms-post strong { color: var(--text); }
.ms-post .lead { color: var(--text2); line-height: 1.9; }
.ms-post .card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin: 24px 0;
}
.ms-post .card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.ms-post .card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
}
.ms-post .card.blue::before   { background: var(--accent); }
.ms-post .card.gold::before   { background: var(--gold); }
.ms-post .card.teal::before   { background: var(--teal); }
.ms-post .card.coral::before  { background: var(--coral); }
.ms-post .card.purple::before { background: var(--accent2); }
.ms-post .card.orange::before { background: var(--orange); }
.ms-post .card-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.ms-post .card.blue   .card-label { color: var(--accent); }
.ms-post .card.gold   .card-label { color: var(--gold); }
.ms-post .card.teal   .card-label { color: var(--teal); }
.ms-post .card.coral  .card-label { color: var(--coral); }
.ms-post .card.purple .card-label { color: var(--accent2); }
.ms-post .card.orange .card-label { color: var(--orange); }
.ms-post .card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}
.ms-post .card-desc {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.65;
  margin: 0;
}
.ms-post .callout {
  border-radius: 12px;
  padding: 16px 20px;
  margin: 20px 0;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.ms-post .callout::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}
.ms-post .callout-info { background: rgba(79,107,237,0.05); border-color: rgba(79,107,237,0.18); }
.ms-post .callout-info::before { background: var(--accent); }
.ms-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); }
.ms-post .callout-warn::before { background: var(--gold); }
.ms-post .callout-teal { background: rgba(10,143,114,0.05); border-color: rgba(10,143,114,0.20); }
.ms-post .callout-teal::before { background: var(--teal); }
.ms-post .callout-purple { background: rgba(139,92,246,0.05); border-color: rgba(139,92,246,0.20); }
.ms-post .callout-purple::before { background: var(--accent2); }
.ms-post .callout-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.ms-post .callout-info .callout-title { color: var(--accent); }
.ms-post .callout-warn .callout-title { color: var(--gold); }
.ms-post .callout-teal .callout-title { color: var(--teal); }
.ms-post .callout-purple .callout-title { color: var(--accent2); }
.ms-post .callout p { margin: 0; font-size: 13px; color: var(--text2); line-height: 1.75; }
.ms-post .code-block {
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
.ms-post .code-block .kw  { color: #a78bfa; }
.ms-post .code-block .fn  { color: #34d399; }
.ms-post .code-block .cm  { color: #525a78; font-style: italic; }
.ms-post .code-block .num { color: #fb923c; }
.ms-post .code-block .str { color: #fbbf24; }
.ms-post .code-block .ty  { color: #38bdf8; }
.ms-post .code-lang {
  position: absolute;
  top: 10px; right: 14px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #525a78;
}
.ms-post .flow-row {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin: 24px 0;
  overflow-x: auto;
}
.ms-post .flow-step {
  flex: 1;
  min-width: 124px;
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 12px 12px;
  position: relative;
  text-align: center;
}
.ms-post .flow-step.fixed { background: rgba(214,48,74,0.06); border-color: rgba(214,48,74,0.28); }
.ms-post .flow-step.prog  { background: rgba(10,143,114,0.07); border-color: rgba(10,143,114,0.30); }
.ms-post .flow-step .step-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: var(--text3);
  margin-bottom: 4px;
}
.ms-post .flow-step .step-name {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}
.ms-post .flow-step .step-desc {
  font-size: 10.5px;
  color: var(--text2);
  line-height: 1.45;
}
.ms-post .flow-step .io {
  font-size: 10px;
  line-height: 1.5;
  text-align: left;
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px dashed var(--border2);
  color: var(--text2);
}
.ms-post .flow-step .io b {
  display: inline-block;
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 0 4px;
  border-radius: 3px;
  margin-right: 3px;
}
.ms-post .flow-step .io b.in  { color: var(--accent); background: rgba(79,107,237,0.12); }
.ms-post .flow-step .io b.out { color: var(--teal); background: rgba(10,143,114,0.12); }
.ms-post .flow-arrow {
  display: flex;
  align-items: center;
  padding: 0 5px;
  color: var(--text3);
  font-size: 16px;
  flex-shrink: 0;
}
.ms-post .step-block {
  border-left: 3px solid var(--border2);
  padding: 16px 20px;
  margin: 16px 0;
  background: var(--surface);
  border-radius: 0 10px 10px 0;
}
.ms-post .step-block.s1 { border-color: var(--coral); }
.ms-post .step-block.s2 { border-color: var(--gold); }
.ms-post .step-block.s3 { border-color: var(--teal); }
.ms-post .step-block.s4 { border-color: var(--accent); }
.ms-post .step-block h4 {
  font-size: 14px;
  font-weight: 700;
  margin: 0 0 6px 0;
}
.ms-post .step-block.s1 h4 { color: var(--coral); }
.ms-post .step-block.s2 h4 { color: var(--gold); }
.ms-post .step-block.s3 h4 { color: var(--teal); }
.ms-post .step-block.s4 h4 { color: var(--accent); }
.ms-post .step-block p {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.75;
  margin: 0 0 8px 0;
}
.ms-post .step-block p:last-child { margin-bottom: 0; }
.ms-post .legend {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text2);
  margin: 8px 0 0;
}
.ms-post .legend .dot { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
.ms-post .legend .dot.fixed { background: var(--coral); }
.ms-post .legend .dot.prog  { background: var(--teal); }
.ms-post table.cmp { width: 100%; border-collapse: collapse; font-size: 13px; margin: 20px 0; }
.ms-post table.cmp th {
  padding: 10px 14px; border: 1px solid var(--border);
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left;
  background: var(--surface2); color: var(--text3);
}
.ms-post table.cmp th.t { color: var(--coral); }
.ms-post table.cmp th.m { color: var(--teal); }
.ms-post table.cmp td { padding: 9px 14px; border: 1px solid var(--border); color: var(--text2); vertical-align: top; }
.ms-post table.cmp tr:nth-child(even) td { background: var(--surface); }
.ms-post .ref-list { list-style: none; padding-left: 0; margin: 16px 0; }
.ms-post .ref-list li { font-size: 13px; color: var(--text2); line-height: 1.7; padding: 7px 0; border-bottom: 1px solid var(--border); }
.ms-post .ref-list li:last-child { border-bottom: none; }
.ms-post .ref-list .ref-tag { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--accent2); font-weight: 600; }
</style>

<div class="ms-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# Mesh Shader가 푸는 문제

<div class="ms-post">
<p class="lead">
GPU는 지난 30년 동안 더 많은 삼각형을 더 빠르게 그리는 방향으로 발전해 왔다. 하지만 게임의 규모가 커지면서 문제는 단순히 <strong>"얼마나 빨리 그릴 수 있는가"</strong>가 아니라, <strong>"무엇을 그릴 것인가"</strong>가 되었다.
</p>
<p>
수백만 개의 삼각형을 가진 장면에서는 화면에 보이지 않는 지오메트리를 최대한 빨리 제거하고(<strong>Efficient Culling</strong>), 거리와 상황에 맞는 <strong>LOD</strong>를 선택하며, 필요한 지오메트리를 동적으로 생성(<strong>Procedural Generation</strong>)하는 능력이 점점 더 중요해졌다.
</p>
<p>
그러나 기존 그래픽스 파이프라인은 이러한 작업을 수행하기에 충분히 유연하지 않았다. Input Assembler를 중심으로 한 고정된 지오메트리 프론트엔드는 CPU가 정해 준 데이터를 순서대로 처리하는 구조였고, 지오메트리를 어떻게 조직하고 처리할지는 개발자가 직접 제어하기 어려웠다.
</p>
<p>
Mesh Shader는 바로 이러한 문제를 해결하기 위해 등장했다. 지오메트리 프론트엔드를 컴퓨트 셰이더와 같은 프로그래밍 모델로 바꾸어, 컬링과 LOD, 그리고 Procedural Generation을 훨씬 효율적으로 수행할 수 있도록 만든 것이다.
</p>

<div class="callout callout-purple">
<div class="callout-title">한 줄로: Mesh Shader가 푸는 문제</div>
<p>GPU가 그림을 그리려면 먼저 <strong>정점(vertex)을 하나하나 처리</strong>해야 한다. 그런데 예전 방식에선 <strong>무엇을 정점으로 넣을지 CPU가 미리 정해 GPU에 통째로 넘겨주고</strong>, GPU는 받은 정점을 <strong>무조건 전부 처리</strong>했다. 그래서 화면에 안 보일 정점(화면 밖·뒷면)까지 <strong>일단 변환을 다 거친 뒤에야 버려졌다</strong> — 보이지도 않을 것에 계산을 다 써버리는 낭비다.</p>
<p>결국 Mesh Shader가 해결하려는 문제는 <strong>"더 많은 정점을 처리하는 것"</strong>이 아니라 <strong>"불필요한 정점을 애초에 처리하지 않는 것"</strong>이다. 이를 위해 지오메트리를 <strong>meshlet 단위</strong>로 조직하고, 컬링과 LOD, Procedural Generation을 GPU가 직접 수행할 수 있도록 <strong>지오메트리 프론트엔드를 프로그래머블하게</strong> 만들었다.</p>
</div>

<div class="callout callout-info">
<div class="callout-title">이 글의 흐름</div>
<p>① 전통 파이프라인(픽셀 셰이더까지)이 무엇이고 어디서 막혔는지 → ② 컴퓨트 셰이더와 <code>Dispatch</code>라는 사고방식 → ③ GPU-driven 렌더링은 왜 나왔나(전통 방식이 "어려워서"였나?) → ④ Mesh Shader / Amplification Shader가 정확히 무엇을 대체하는가 → ⑤ UE5 Nanite의 실제 mesh shader 코드. 앞 단계가 다음 단계의 <em>동기</em>가 되도록 쌓아 올린다.</p>
</div>

<span class="section-eyebrow">01 — 전통 파이프라인</span>

</div>

# 전통적인 래스터 파이프라인: IA부터 Pixel Shader까지

<div class="ms-post">
<p>
화면에 삼각형을 그리는 고전적인 경로는 단계가 정해진 컨베이어 벨트다. 데이터가 한 방향으로만 흐르고, 각 단계는 앞 단계의 출력만 받는다.
</p>

<div class="flow-row">
<div class="flow-step fixed"><div class="step-num">고정함수</div><div class="step-name">Input<br>Assembler</div><div class="step-desc">인덱스/정점 버퍼를 읽어 정점을 조립</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step prog"><div class="step-num">프로그래머블</div><div class="step-name">Vertex<br>Shader</div><div class="step-desc">정점 1개 → 정점 1개 변환</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step prog"><div class="step-num">선택·프로그래머블</div><div class="step-name">Hull / Tess / Domain</div><div class="step-desc">테셀레이션(분할)</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step prog"><div class="step-num">선택·프로그래머블</div><div class="step-name">Geometry<br>Shader</div><div class="step-desc">프리미티브 생성/삭제</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step fixed"><div class="step-num">고정함수</div><div class="step-name">Rasterizer</div><div class="step-desc">삼각형 → 픽셀(쿼드)</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step prog"><div class="step-num">프로그래머블</div><div class="step-name">Pixel<br>Shader</div><div class="step-desc">픽셀 1개 → 색 1개</div></div>
</div>
<p class="legend"><span><span class="dot fixed"></span>고정함수(내가 못 바꿈)</span><span><span class="dot prog"></span>프로그래머블(셰이더로 작성)</span></p>

<p>
핵심은 두 가지 색이다. <strong>초록(프로그래머블)</strong>은 내가 셰이더 코드로 자유롭게 짜는 부분이고, <strong>빨강(고정함수)</strong>은 하드웨어/드라이버가 정한 규칙대로만 동작해 내가 끼어들 수 없는 부분이다. 전통 파이프라인의 한계는 거의 전부 이 <strong>빨강 단계</strong>, 특히 맨 앞 <strong>Input Assembler</strong>에서 나온다.
</p>

<div class="step-block s1">
<h4>Input Assembler (IA) — 모든 것의 시작이자 족쇄</h4>
<p>IA는 "정점 버퍼와 인덱스 버퍼를 읽어, 입력 레이아웃(어느 바이트가 position이고 어느 바이트가 normal인지)대로 정점 구조체를 조립해 Vertex Shader에 한 개씩 먹이는" 고정함수 단계다. <strong>여기서 무엇을 그릴지는 CPU가 미리 정한 인덱스 버퍼가 100% 결정한다.</strong> 셰이더는 "이미 정해져 들어온 정점"을 변형할 수만 있을 뿐, 정점을 <em>만들거나·지우거나·순서를 바꿀</em> 수 없다.</p>
</div>

<div class="step-block s2">
<h4>Vertex Shader (VS) — 정점 1개 = 스레드 1개, 이웃은 못 본다</h4>
<p>VS는 정점 하나를 받아 변환된 정점 하나를 내보낸다. 깔끔하지만 제약이 크다. <strong>한 정점은 자기 이웃 정점을 볼 수 없고</strong>, 삼각형 단위 판단(예: 이 면이 뒤를 보고 있으니 버리자)을 VS 단계에서 할 수 없다. 컬링은 한참 뒤 래스터라이저에 가서야 일어난다.</p>
</div>

<div class="step-block s3">
<h4>Tessellation / Geometry Shader — "더 만들 수 있다"는 약속의 함정</h4>
<p>지오메트리를 동적으로 늘리려면 Tessellation(테셀레이션)이나 Geometry Shader(GS)를 쓴다. 특히 GS는 "삼각형 1개를 받아 0개\~여러 개의 프리미티브를 출력"하는, 유일하게 지오메트리를 자유롭게 증감하는 단계였다. 그런데 GS는 <strong>현장에서 "쓰지 마라"로 통하는 악명</strong>을 얻었다. 이유는 다음 절에서.</p>
</div>

<div class="step-block s4">
<h4>Rasterizer → Pixel Shader — 여기는 잘 돌아간다</h4>
<p>래스터라이저가 삼각형을 픽셀(정확히는 2×2 쿼드)로 쪼개고, Pixel Shader가 픽셀마다 색을 계산한다. 픽셀 단계는 GPU가 가장 잘하는 대규모 병렬 작업이라 병목이 아니다. 문제는 <strong>"픽셀 셰이더에 도달하기 전, 지오메트리를 만들어 보내는 앞단"</strong>이었다.</p>
</div>

<span class="section-eyebrow">02 — 앞단의 병목</span>

</div>

# 왜 앞단이 병목인가: 직렬 정점 공급과 GS의 실패

<div class="ms-post">
<p>
전통 프론트엔드의 한계를 세 가지로 정리하면 이렇다.
</p>

<div class="card-grid">
<div class="card coral">
<div class="card-label">한계 1</div>
<div class="card-title">IA가 고정 — 입력을 못 바꾼다</div>
<div class="card-desc">무엇을 그릴지는 CPU가 만든 인덱스 버퍼가 결정한다. "이 삼각형은 화면 밖이니 아예 정점 변환도 하지 말자" 같은 판단을 프론트엔드에서 내릴 방법이 없다. 일단 들어오면 다 변환하고 나서 뒤에서 버린다.</div>
</div>
<div class="card gold">
<div class="card-label">한계 2</div>
<div class="card-title">정점 재사용의 한계 (post-transform cache)</div>
<div class="card-desc">인접 삼각형이 정점을 공유해도, 작은 캐시 범위를 벗어나면 같은 정점이 여러 번 셰이딩된다. 최적화 안 한 Stanford Bunny는 정점이 평균 <strong>4.13배</strong> 중복 처리됐고, meshoptimizer로 정렬해도 1.40배가 남았다. "이상적 1.0배"는 구조상 도달 불가.</div>
</div>
<div class="card purple">
<div class="card-label">한계 3</div>
<div class="card-title">Geometry Shader가 느리다</div>
<div class="card-desc">유일하게 지오메트리를 증감하던 GS가 성능 함정이었다. 다음 카드에서 그 구조적 이유를 본다.</div>
</div>
</div>

<div class="callout callout-warn">
<div class="callout-title">Geometry Shader는 왜 실패했나</div>
<p>GS의 근본 문제는 <strong>"출력을 입력 순서대로 보장해야 한다"</strong>는 API 규칙이다. GPU는 수천 스레드를 제멋대로 병렬 실행하는데, GS는 그 결과를 <em>원래 프리미티브 순서대로</em> 다음 단계에 흘려야 한다. 그래서 각 스레드의 가변 길이 출력을 고정 크기 온칩 버퍼에 모았다가 순서대로 직렬화해야 했고, 이 <strong>순서 보장 + 가변 출력 버퍼링</strong>이 병렬성을 죽였다. 게다가 출력량을 미리 최대치로 잡아야 해 점유율(occupancy)도 떨어졌다. 결과적으로 "프리미티브를 늘리는 가장 유연한 도구"가 가장 쓰면 안 되는 도구가 됐다.</p>
</div>

<p>
세 한계의 공통 뿌리는 결국 하나다. <strong>지오메트리 프론트엔드가 "정점 1개 = 작업 1개"라는 고정된 모양으로 박혀 있고, 그 흐름과 순서를 내가 프로그래밍할 수 없다</strong>는 것. "내가 직접 스레드를 원하는 만큼 띄워서, 원하는 데이터를 읽어, 원하는 결과를 내는" 자유 — 그게 바로 컴퓨트 셰이더가 이미 가지고 있던 것이었다.
</p>

<span class="section-eyebrow">03 — 컴퓨트와 Dispatch</span>

</div>

# 컴퓨트 셰이더와 'Dispatch'라는 사고방식

<div class="ms-post">
<p>
컴퓨트 셰이더는 그래픽스 파이프라인 <em>밖</em>에 있다. 삼각형도, 정점도, 픽셀도 모른다. 그냥 <strong>"스레드 격자(grid)를 띄워라"</strong>가 전부다. 이 호출이 <code>Dispatch</code>다.
</p>

<div class="code-block"><span class="code-lang">HLSL</span><span class="cm">// 셰이더: 한 "그룹"이 몇 개의 스레드로 구성되는지 선언</span>
\[<span class="fn">numthreads</span>(<span class="num">8</span>, <span class="num">8</span>, <span class="num">1</span>)]   <span class="cm">// 그룹당 8\*8\*1 = 64 스레드</span>
<span class="kw">void</span> <span class="fn">MyCS</span>(<span class="ty">uint3</span> id : <span class="ty">SV\_DispatchThreadID</span>)
{
    <span class="cm">// id = 이 스레드가 전체 격자에서 몇 번째인가 (전역 좌표)</span>
    Output\[id.xy] = <span class="fn">DoSomething</span>(id);
}

<span class="cm">// CPU 측: 그룹을 몇 개 띄울지 결정</span>
<span class="fn">Dispatch</span>(<span class="num">100</span>, <span class="num">50</span>, <span class="num">1</span>);  <span class="cm">// 100*50 = 5000 그룹 → 총 5000*64 = 320,000 스레드</span></div>

<p>
여기서 <strong>두 층의 개념</strong>이 핵심이다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">numthreads(X,Y,Z)</div>
<div class="card-title">한 그룹 안의 스레드 수</div>
<div class="card-desc">셰이더에 박아두는 값. 한 <strong>Thread Group</strong>은 X·Y·Z개 스레드로 구성되고, 같은 그룹의 스레드끼리는 <strong>groupshared 메모리</strong>로 데이터를 공유하고 동기화할 수 있다. SM5.0 컴퓨트 기준 한 그룹 최대 1024 스레드.</div>
</div>
<div class="card teal">
<div class="card-label">Dispatch(x,y,z)</div>
<div class="card-title">그룹을 몇 개 띄울까</div>
<div class="card-desc">CPU(또는 GPU)가 호출 시 정하는 값. 전체 스레드 수 = <code>Dispatch × numthreads</code>. <code>SV\_DispatchThreadID = GroupID × numthreads + GroupThreadID</code> 로 각 스레드가 자기 전역 위치를 안다.</div>
</div>
</div>

<div class="callout callout-teal">
<div class="callout-title">Draw vs Dispatch — 결정적 차이</div>
<p><strong>Draw</strong>는 "이 정점/인덱스 버퍼로 삼각형을 그려라"다. IA가 정점을 조립해 고정 파이프라인에 먹이는, <em>지오메트리 의미가 박힌</em> 호출이다. <strong>Dispatch</strong>는 "스레드 N개를 띄워라"가 전부다. 무엇을 읽을지, 무엇을 쓸지는 100% 셰이더 코드가 정한다. 고정된 입력 구조가 없다 — 이 <strong>"입력은 워크그룹 인덱스 하나뿐, 나머지는 내가 직접 fetch"</strong>라는 자유가 컴퓨트의 유연함의 본질이다.</p>
</div>

<p>
즉 컴퓨트는 이미 정답을 가지고 있었다. <strong>"고정된 입력 조립 없이, 내가 스레드를 띄워 내가 데이터를 읽는다."</strong> 남은 문제는 — 컴퓨트의 출력을 어떻게 다시 <em>래스터라이저</em>에 연결하느냐였다. Mesh Shader가 나오기 전, 사람들은 먼저 <strong>"무엇을 그릴지 결정하는 일"부터 GPU로 옮겼다.</strong> 그게 GPU-driven 렌더링이다.
</p>

<span class="section-eyebrow">04 — GPU-driven 렌더링</span>

</div>

# GPU-driven 렌더링: "그릴 목록"을 GPU가 만든다

<div class="ms-post">
<p>
전통적으로는 CPU가 매 프레임 "이 메시 그려, 저 메시 그려" 하고 Draw Call을 하나씩 던졌다. 문제는 이 Draw Call 자체가 비싸다는 것.
</p>

<div class="callout callout-warn">
<div class="callout-title">CPU 제출이 병목이 된 이유</div>
<p>Draw Call 하나마다 드라이버(두꺼운 소프트웨어 계층)를 통과하며 상태 검증·변환이 일어난다. 객체가 수만 개면 CPU가 Draw Call을 <em>준비하는 속도</em>가 GPU가 그리는 속도를 못 따라간다 — GPU는 노는데 CPU가 병목. 게다가 "이 객체가 화면에 보이나?"(컬링) 판단도 CPU가 매 프레임 수만 번 해야 했다.</p>
</div>

<p>
GPU-driven 렌더링의 발상은 <strong>"씬 순회·컬링·Draw Call 생성을 전부 GPU에서 하자"</strong>다. 두 개의 도구가 이를 가능케 했다.
</p>

<div class="step-block s4">
<h4>① Indirect Draw — 인자를 버퍼에서 읽는 Draw</h4>
<p>보통 Draw는 인자(정점 수, 인스턴스 수 등)를 CPU가 직접 넘긴다. <strong>Indirect Draw</strong>는 그 인자를 <em>GPU 버퍼에서</em> 읽는다. D3D12의 <code>ExecuteIndirect</code>, Vulkan의 <code>vkCmdDrawIndexedIndirect</code>가 그것. 인자가 GPU 메모리에 있으니, <strong>컴퓨트 셰이더가 그 인자 버퍼를 직접 써넣을 수 있다.</strong> Vulkan의 multi-draw indirect는 한 번의 호출로 <em>Draw 명령 배열 전체</em>를 실행해 호출당 오버헤드도 줄인다.</p>
</div>

<div class="step-block s3">
<h4>② GPU 컬링 — 컴퓨트가 "보이는 것"만 추려 UAV에 append</h4>
<p>컴퓨트 셰이더가 모든 객체를 검사해 <strong>화면에 보이는 명령만 골라 UAV(append 버퍼)에 쌓고</strong>, <code>ExecuteIndirect</code>가 그 버퍼를 그대로 소비한다. CPU는 객체별 가시성 판단에서 완전히 손을 뗀다. (D3D12 공식 샘플은 1024개 Draw 명령 버퍼를 GPU에서 필터링한다.) Vulkan에선 <code>instanceCount</code>를 0/1로 토글해 같은 일을 한다.</p>
</div>

<div class="callout callout-purple">
<div class="callout-title">"전통 방식이 어려워서 GPU-driven이 나온 건가?" — 절반만 맞다</div>
<p>정확히는 <strong>"어려워서"가 아니라 "확장이 안 돼서"</strong>다. 전통 CPU-driven 방식은 객체 수가 적을 땐 멀쩡하다. 다만 객체가 수만\~수십만이 되면 <strong>CPU 제출 비용이 선형으로 늘어</strong> GPU를 못 먹인다. GPU-driven은 이 "스케일 한계"를 깨려고 컬링·명령 생성을 대규모 병렬인 GPU로 옮긴 것이다.</p>
<p style="margin-top:8px;">하지만 여기엔 미완성이 남아 있었다. GPU가 "그릴 목록"을 만들어도, 실제 그리기는 여전히 <strong>고정된 IA→VS 프론트엔드</strong>를 거쳐야 했다. 정점을 직렬로 공급하는 그 앞단은 그대로였다. <strong>마지막 고정함수 조각까지 프로그래머블로 바꾼 것</strong> — 그게 Mesh Shader다.</p>
</div>

<span class="section-eyebrow">05 — Mesh Shader 파이프라인</span>

</div>

# Mesh Shader: 프론트엔드를 컴퓨트로 다시 쓰다

<div class="ms-post">
<p>
Mesh Shader는 NVIDIA Turing(2018)에서 처음 나와, 이후 DirectX 12(DX12 Ultimate)와 Vulkan(<code>VK\_EXT\_mesh\_shader</code>)으로 표준화됐다. 핵심 한 줄: <strong>IA + VS + (Tessellation) + GS 라는 고정/반고정 프론트엔드 전체를, 컴퓨트 모델을 따르는 두 개의 프로그래머블 단계로 교체한다.</strong>
</p>

<div class="flow-row">
<div class="flow-step prog"><div class="step-num">선택·프로그래머블</div><div class="step-name">Amplification<br>(Task) Shader</div><div class="step-desc">몇 개 띄울지 결정 + 컬링</div><div class="io"><b class="in">IN</b> 워크그룹 인덱스 (+버퍼 SRV)<br><b class="out">OUT</b> Mesh 그룹 수 + payload</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step prog"><div class="step-num">프로그래머블</div><div class="step-name">Mesh<br>Shader</div><div class="step-desc">meshlet → 정점·삼각형</div><div class="io"><b class="in">IN</b> meshlet(직접 fetch) + payload<br><b class="out">OUT</b> 정점 + 삼각형 + per-prim 속성</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step fixed"><div class="step-num">고정함수</div><div class="step-name">Rasterizer</div><div class="step-desc">삼각형 → 픽셀</div><div class="io"><b class="in">IN</b> 정점 + 삼각형<br><b class="out">OUT</b> 픽셀(쿼드) + 보간 속성</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step prog"><div class="step-num">프로그래머블</div><div class="step-name">Pixel<br>Shader</div><div class="step-desc">픽셀 → 색</div><div class="io"><b class="in">IN</b> 보간 속성 (+per-prim)<br><b class="out">OUT</b> 색 (+깊이)</div></div>
</div>
<p class="legend"><span><span class="dot fixed"></span>고정함수</span><span><span class="dot prog"></span>프로그래머블</span> \&nbsp;— 앞단의 빨강(IA)이 사라졌다.</p>

<table class="cmp">
<thead><tr><th class="t">전통 파이프라인</th><th class="m">Mesh Shader 파이프라인</th></tr></thead>
<tbody>
<tr><td>Input Assembler(고정) — 인덱스/정점 버퍼 강제</td><td><strong>IA 비활성</strong> — PSO에 인덱스 버퍼·입력 레이아웃 자체가 없음. 데이터는 셰이더가 직접 읽는다</td></tr>
<tr><td>정점 1개 = 스레드 1개</td><td>Thread Group이 협력해 정점·프리미티브 <strong>배치</strong>를 생산 (컴퓨트 모델)</td></tr>
<tr><td>이웃 정점·삼각형을 못 봄</td><td>groupshared·wave 명령으로 그룹 내 공유·협력 가능</td></tr>
<tr><td>지오메트리 증감은 GS(느림)로만</td><td>Mesh/Task 셰이더가 자유롭게 생성·컬링 (메모리에 새 인덱스 버퍼를 쓰지 않고)</td></tr>
<tr><td>per-vertex 속성만</td><td><strong>per-primitive 속성</strong> 출력 가능 (삼각형마다 별도 값)</td></tr>
</tbody>
</table>

<div class="callout callout-info">
<div class="callout-title">왜 "컴퓨트 모델"이 결정적인가</div>
<p>NVIDIA 표현 그대로: <em>"mesh·task 셰이더는 모두 컴퓨트 셰이더의 프로그래밍 모델을 따르며, 협력 스레드 그룹을 쓰고, 워크그룹 인덱스 외에는 입력이 없다."</em> 즉 프론트엔드가 <strong>Dispatch만큼 자유로워졌다.</strong> 03절에서 본 컴퓨트의 자유("입력 고정 없음, 내가 직접 fetch")가 드디어 래스터라이저 앞단에 들어온 것이다.</p>
</div>
</div>

## Meshlet — 메시를 작은 클러스터로 쪼갠다

<div class="ms-post">
<p>
Mesh Shader의 핵심 데이터 구조는 <strong>meshlet</strong>이다. 이름은 <code>mesh + -let</code>에서 왔다. <code>-let</code>은 booklet(작은 책)·droplet(작은 물방울)·piglet(새끼 돼지)처럼 영어에서 <strong>"작은 것"</strong>을 뜻하는 축소 접미사이니, meshlet은 말 그대로 <strong>"작은 메시 조각"</strong>이라는 뜻이다. 개념(지오메트리를 클러스터로 묶기) 자체는 그 전부터 있었지만, 이 용어는 <strong>NVIDIA가 2018년 Turing mesh shader를 발표하며 대중화</strong>시켰다. 메시 전체를 <strong>정점 상한 V개, 프리미티브 상한 P개짜리 작은 덩어리</strong>들로 미리(오프라인) 쪼개 둔다. 각 meshlet은 "고유 정점 집합 + 로컬 인덱스 리스트"로 표현되고, 연결성(connectivity)에 제약이 없다. GPU는 이 meshlet 하나를 <strong>Thread Group 하나</strong>로 처리한다.
</p>

<div class="card-grid">
<div class="card teal">
<div class="card-label">NVIDIA (Turing/Ampere)</div>
<div class="card-title">64 정점 / 126 프리미티브</div>
<div class="card-desc">권장값. 126은 <code>3×126+4</code>가 384(=3×128)바이트 블록에 딱 맞게 떨어지도록 고른 값. 32스레드 구성에선 64정점/84프리미티브가 실전 스윗스폿.</div>
</div>
<div class="card coral">
<div class="card-label">AMD (RDNA)</div>
<div class="card-title">128 정점 / 256 삼각형</div>
<div class="card-desc">권장값. 2-manifold 메시에서 <code>V \&lt; T \&lt; 2V</code> 비율 가이드. 정점 중복과 성능의 균형점.</div>
</div>
<div class="card blue">
<div class="card-label">D3D12 스펙(상한)</div>
<div class="card-title">그룹 ≤128 스레드 / 출력 ≤256·256</div>
<div class="card-desc">한 mesh 그룹은 X·Y·Z ≤ 128 스레드, 출력 정점 ≤256·프리미티브 ≤256, groupshared 28KB(컴퓨트는 32KB). 128스레드면 스레드:정점 1:1 매핑.</div>
</div>
</div>
<p style="font-size:12.5px;color:var(--text3);">※ NVIDIA·AMD 숫자는 특정 세대 <em>권장값</em>, D3D12 숫자는 API <em>이식 가능 상한</em>이다. 세대가 올라가면 달라진다.</p>
</div>

## Mesh Shader는 어떻게 출력하나

<div class="ms-post">
<p>
Mesh Shader의 출력 규약은 컴퓨트와 다르다. 먼저 <code>SetMeshOutputCounts(정점수, 프리미티브수)</code>로 <strong>"이 그룹이 정점 몇 개·삼각형 몇 개를 낼지"를 먼저 선언</strong>하고, 그다음 정점 배열·인덱스 배열·per-primitive 속성 배열을 채운다.
</p>

<div class="code-block"><span class="code-lang">HLSL — Mesh Shader 골격</span>\[<span class="fn">numthreads</span>(<span class="num">128</span>, <span class="num">1</span>, <span class="num">1</span>)]
\[<span class="fn">outputtopology</span>(<span class="str">"triangle"</span>)]
<span class="kw">void</span> <span class="fn">MeshMain</span>(
    <span class="ty">uint</span> tid : <span class="ty">SV\_GroupThreadID</span>,
    <span class="ty">uint</span> gid : <span class="ty">SV\_GroupID</span>,            <span class="cm">// 이 그룹 = meshlet 하나</span>
    <span class="kw">out</span> <span class="ty">vertices</span>   VertexOut verts\[<span class="num">64</span>],
    <span class="kw">out</span> <span class="ty">indices</span>    <span class="ty">uint3</span>     tris\[<span class="num">126</span>],
    <span class="kw">out</span> <span class="ty">primitives</span> PrimOut   prims\[<span class="num">126</span>])  <span class="cm">// per-primitive 속성</span>
{
    Meshlet m = Meshlets\[gid];                  <span class="cm">// 데이터는 내가 직접 fetch</span>
    <span class="fn">SetMeshOutputCounts</span>(m.vertCount, m.primCount); <span class="cm">// ① 먼저 개수 선언</span>

&#x20;   <span class="kw">if</span> (tid \&lt; m.vertCount)
        verts\[tid] = <span class="fn">TransformVertex</span>(...);          <span class="cm">// ② 정점 쓰기</span>
    <span class="kw">if</span> (tid \&lt; m.primCount) {
        tris\[tid]  = <span class="fn">LoadLocalIndices</span>(m, tid);       <span class="cm">// ③ 삼각형 인덱스</span>
        prims\[tid] = <span class="fn">MakePrimAttr</span>(...);             <span class="cm">// ④ 삼각형별 속성</span>
    }

}</div>

<p>
주목할 점: <strong>한 스레드가 정점 하나 + 삼각형 하나를 동시에 담당</strong>하고, 그룹 전체가 협력해 meshlet 하나를 출력한다. 인덱스 버퍼를 메모리에 새로 쓰지 않고도 그 자리에서 컬링(예: 후면 삼각형은 출력에서 빼기)이 가능하다. 이게 GS가 못 했던 "값싸고 병렬적인 지오메트리 증감"이다.
</p>
</div>

## API는 뭘 넘기나 — IA 없이 버퍼 바인딩 + DispatchMesh

<div class="ms-post">
<p>
전통 경로는 <code>IASetVertexBuffers</code>·<code>IASetIndexBuffer</code>로 IA에 버퍼를 물려 정점을 자동 공급받았다. <strong>Mesh shader엔 IA가 없으니 이 <code>IASet\*</code> 호출 자체를 쓰지 않는다.</strong> 대신 컴퓨트 셰이더처럼 <strong>버퍼를 SRV로 바인딩</strong>하고, 셰이더가 직접 인덱싱해 읽는다. CPU가 호출 시 넘기는 건 지오메트리가 아니라 <strong>"스레드 그룹을 몇 개 띄울지"</strong>뿐이다.
</p>

<table class="cmp">
<thead><tr><th class="t">전통 (Draw)</th><th class="m">Mesh shader (DispatchMesh)</th></tr></thead>
<tbody>
<tr><td><code>IASetVertexBuffers</code> / <code>IASetIndexBuffer</code></td><td>없음 — 버퍼를 <strong>SRV(루트 시그니처)</strong>로 바인딩</td></tr>
<tr><td>IA가 인덱스/정점을 자동 fetch</td><td>셰이더가 <code>Meshlets\[gid]</code>로 직접 fetch</td></tr>
<tr><td><code>DrawIndexedInstanced(인덱스 수, ...)</code></td><td><code>DispatchMesh(그룹 수, 1, 1)</code> — 개수만</td></tr>
<tr><td>PSO에 InputLayout 필수</td><td>PSO에 InputLayout/IB <strong>없음</strong></td></tr>
</tbody>
</table>

<div class="code-block"><span class="code-lang">C++ (D3D12) — IA 없이 바인딩 + 디스패치</span><span class="cm">// IASet\* 호출이 하나도 없다</span>
cmd-\&gt;<span class="fn">SetGraphicsRootShaderResourceView</span>(<span class="num">0</span>, meshletBuffer-\&gt;GetGPUVirtualAddress());   <span class="cm">// meshlet 테이블</span>
cmd-\&gt;<span class="fn">SetGraphicsRootShaderResourceView</span>(<span class="num">1</span>, uniqueVertexIB-\&gt;GetGPUVirtualAddress());  <span class="cm">// 고유 정점 인덱스</span>
cmd-\&gt;<span class="fn">SetGraphicsRootShaderResourceView</span>(<span class="num">2</span>, primitiveIB-\&gt;GetGPUVirtualAddress());    <span class="cm">// 삼각형(로컬) 인덱스</span>
cmd-\&gt;<span class="fn">SetGraphicsRootShaderResourceView</span>(<span class="num">3</span>, vertexBuffer-\&gt;GetGPUVirtualAddress());    <span class="cm">// 정점 데이터</span>
cmd-\&gt;<span class="fn">DispatchMesh</span>(meshletCount, <span class="num">1</span>, <span class="num">1</span>);  <span class="cm">// "그룹 meshletCount개 띄워" — 지오메트리 인자 없음</span></div>

<div class="callout callout-info">
<div class="callout-title">입력과 출력의 방향</div>
<p><strong>넘기는 것</strong>: 지오메트리가 아니라 "그룹 몇 개"(+ 버퍼는 미리 SRV 바인딩). <strong>입력</strong>: 그룹마다 <code>SV\_GroupID</code>로 meshlet 하나를 <em>직접 읽는다</em>. <strong>출력</strong>: meshlet이 아니라 <em>변환된 정점·삼각형</em>을 래스터라이저로 보낸다. 즉 mesh shader는 <strong>meshlet을 "소비"해 정점·삼각형을 "생산"</strong>한다 — meshlet을 다시 내보내는 게 아니다.</p>
</div>

<span class="section-eyebrow">06 — Amplification(Task) Shader</span>

</div>

# Amplification(Task) Shader: Mesh를 몇 개 띄울지 GPU가 정한다

<div class="ms-post">
<p>
Mesh Shader 앞에 <strong>선택적으로</strong> 붙는 단계가 Amplification Shader(D3D12 명칭) = Task Shader(Vulkan/NVIDIA 명칭)다. 역할은 한 줄: <strong>"이번에 Mesh Shader Thread Group을 몇 개나 띄울지"를 GPU에서 동적으로 결정</strong>하는 것이다. 호출 API가 <code>DispatchMesh(그룹 수, 1, 1, payload)</code>이고, 실제 컬링 코드는 아래 '실전'에서 본다.
</p>

<div class="card-grid">
<div class="card purple">
<div class="card-label">동적 확장 / 컬링</div>
<div class="card-title">보이는 것만 Mesh로 넘긴다</div>
<div class="card-desc">절두체·오클루전 컬링, LOD 선택을 <strong>Mesh Shader가 돌기 전에</strong> 미리 끝낸다. 안 보이는 meshlet 그룹은 아예 Mesh Shader를 띄우지 않는다 — 한계 1(들어오면 다 변환)을 정면으로 해결.</div>
</div>
<div class="card blue">
<div class="card-label">payload</div>
<div class="card-title">자식에게 데이터 전달</div>
<div class="card-desc">Amp 그룹이 띄운 모든 Mesh 그룹에 공유되는 payload(D3D12 최대 16KB). 보통 "살아남은 meshlet 인덱스 목록"을 담는다. 단 16KB는 상한일 뿐, 작게 쓸수록 빠르다.</div>
</div>
</div>

<div class="callout callout-teal">
<div class="callout-title">GPU-driven과 Mesh Shader가 만나는 지점</div>
<p>04절의 <code>ExecuteIndirect</code>에는 <code>DISPATCH\_MESH</code>라는 인자 타입이 추가됐다. 즉 <strong>GPU가 만든 명령 버퍼로 mesh 파이프라인 자체를 indirect하게 띄울 수 있다.</strong> "GPU가 그릴 목록을 만든다"(GPU-driven)와 "GPU가 지오메트리를 프로그래밍으로 생성한다"(Mesh Shader)가 여기서 하나로 합쳐진다. 이 조합이 바로 Nanite가 서 있는 토대다.</p>
</div>
</div>

## 실전: 변환 전에 정점을 버리는 컬링 코드

<div class="ms-post">
<p>
서두에서 말한 <strong>"안 보일 정점을 변환 전에 버린다"</strong>가 실제로 일어나는 곳이 바로 이 amplification shader다. 핵심 아이디어: <strong>meshlet 단위로 절두체·후면 검사를 먼저 하고, 통과한 meshlet만 mesh 그룹으로 띄운다.</strong> 탈락한 meshlet은 mesh shader가 아예 실행되지 않으니, 그 정점들은 <strong>변환조차 되지 않는다.</strong>
</p>

<div class="code-block"><span class="code-lang">HLSL — Amplification: meshlet 컬링 + 스트림 압축</span><span class="kw">struct</span> Payload { <span class="ty">uint</span> MeshletIndices\[<span class="num">32</span>]; };  <span class="cm">// 살아남은 meshlet 인덱스</span>
<span class="kw">groupshared</span> Payload s\_Payload;

\[<span class="fn">numthreads</span>(<span class="num">32</span>, <span class="num">1</span>, <span class="num">1</span>)]              <span class="cm">// 32 = 1 wave (wave 명령으로 압축)</span>
<span class="kw">void</span> <span class="fn">AmpMain</span>(<span class="ty">uint</span> dtid : <span class="ty">SV\_DispatchThreadID</span>)
{
<span class="kw">bool</span> visible = <span class="kw">false</span>;
<span class="ty">uint</span> mi = dtid;                          <span class="cm">// 스레드 1개 = meshlet 1개 검사</span>
<span class="kw">if</span> (mi < MeshletCount)
{
MeshletBounds b = BoundsBuffer\[mi];   <span class="cm">// 오프라인에 구운 바운드(구+cone)</span>
visible  = <span class="fn">InFrustum</span>(b.Center, b.Radius);             <span class="cm">// ① 절두체 컬링</span>
visible = visible \&\& !<span class="fn">ConeBackfaceCull</span>(b.ConeApex,       <span class="cm">// ② 후면 cone 컬링</span>
b.ConeAxis, b.ConeCutoff, CameraPos);
}

&#x20;   <span class="ty">uint</span> slot = <span class="fn">WavePrefixCountBits</span>(visible);   <span class="cm">// ③ 내 앞 생존자 수 = 내 자리</span>
    <span class="kw">if</span> (visible) s\_Payload.MeshletIndices\[slot] = mi;  <span class="cm">//    살아남은 것만 앞쪽에 압축</span>
    <span class="ty">uint</span> survivors = <span class="fn">WaveActiveCountBits</span>(visible);  <span class="cm">// 총 생존 수</span>

    <span class="fn">DispatchMesh</span>(survivors, <span class="num">1</span>, <span class="num">1</span>, s\_Payload); <span class="cm">// ④ 생존 meshlet 수만큼만 mesh 그룹 launch</span>

}</div>

<p>
탈락한 meshlet은 <code>DispatchMesh</code>가 그만큼 적게 띄우므로 <strong>mesh shader가 실행되지 않고 → 정점 변환도 없다.</strong> 이게 전통 VS가 못 하던 "변환 전에 안 그리기"의 실체다. 한 단계 더 들어가면, mesh shader 안에서 <strong>삼각형 단위 후면 컬링</strong>도 가능하다 — 살아남은 삼각형만 세어 <code>SetMeshOutputCounts</code>에 넘기면 된다.
</p>

<div class="code-block"><span class="code-lang">HLSL — Mesh shader: per-triangle 후면 컬링 (스케치)</span>\[<span class="fn">numthreads</span>(<span class="num">128</span>, <span class="num">1</span>, <span class="num">1</span>)]
\[<span class="fn">outputtopology</span>(<span class="str">"triangle"</span>)]
<span class="kw">void</span> <span class="fn">MeshMain</span>(<span class="ty">uint</span> tid : <span class="ty">SV\_GroupThreadID</span>, <span class="ty">uint</span> gid : <span class="ty">SV\_GroupID</span>,
              <span class="kw">in</span> <span class="ty">payload</span> Payload pl, <span class="cm">/\* out verts/tris/prims \*/</span> ...)
{
    Meshlet m = Meshlets\[pl.MeshletIndices\[gid]]; <span class="cm">// amp가 골라준 meshlet</span>
    <span class="cm">// ... 정점 변환 (살아남은 meshlet만 여기 도달) ...</span>

&#x20;   <span class="ty">uint3</span> tri = <span class="fn">LoadLocalIndices</span>(m, tid);
    <span class="kw">bool</span> keep = !<span class="fn">IsBackface</span>(verts\[tri.x].Pos, verts\[tri.y].Pos, verts\[tri.z].Pos);
    <span class="ty">uint</span> visTris = <span class="fn">WaveActiveCountBits</span>(keep);   <span class="cm">// 살아남은 삼각형만</span>
    <span class="fn">SetMeshOutputCounts</span>(m.vertCount, visTris);    <span class="cm">// 후면은 출력에서 제외</span>
    <span class="cm">// ... keep==true 인 삼각형만 압축해 WRITE\_TRIANGLE ...</span>

}</div>

<div class="callout callout-purple">
<div class="callout-title">두 단계 컬링의 효과</div>
<p><strong>1차(amplification)</strong>: meshlet을 통째로 버려 정점 변환 자체를 건너뛴다 — 가장 큰 절약. <strong>2차(mesh)</strong>: 변환한 meshlet 안에서 후면 삼각형을 래스터라이저로 안 보낸다. 둘 다 <strong>"다 그린 뒤 버리기"가 아니라 "처음부터 안 하기"</strong>다. 컬링에 쓰는 바운드(구·cone)는 meshlet을 만들 때 <code>meshopt\_computeMeshletBounds</code> 같은 도구가 오프라인에 미리 구워준다.</p>
</div>

<span class="section-eyebrow">07 — 실사례: UE5 Nanite</span>

</div>

# Nanite는 mesh shader를 실제로 이렇게 쓴다

<div class="ms-post">
<p>
이제 추상이 아니라 실제 코드다. UE5 Nanite는 메시를 <strong>128 삼각형(최대 256 정점) 클러스터</strong>로 쪼갠다 — meshlet과 정확히 같은 개념이고, 128은 GPU 웨이브를 꽉 채우는 32·64의 배수라 고른 값이다. Nanite는 클러스터를 두 경로로 래스터화한다: 큰 삼각형은 <strong>하드웨어(mesh shader)</strong>, 작은 삼각형은 <strong>소프트웨어(컴퓨트)</strong> 래스터라이저. 여기서 우리가 볼 건 하드웨어 경로다.
</p>

<div class="callout callout-info">
<div class="callout-title">검증 출처</div>
<p>아래 코드(① <code>HWRasterizeMS</code> · ② <code>UseMeshShader</code>)는 추정이 아니라 <strong>UE 5.7.4 소스</strong>를 직접 읽어 확인한 것이고, 뒤의 ③ 전수조사는 <strong>UE 5.8 소스</strong> 기준이다. 두 버전에서 해당 경로의 코드는 사실상 동일하다. 핵심 파일: <code>Engine/Shaders/Private/Nanite/NaniteRasterizer.usf</code>, <code>Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShared.cpp</code>.</p>
</div>
</div>

## ① 핵심 셰이더: HWRasterizeMS — 그룹 하나 = 클러스터 하나

<div class="ms-post">
<div class="code-block"><span class="code-lang">NaniteRasterizer.usf (요약)</span><span class="cm">// 한 워크그룹이 Nanite 클러스터 하나를 그린다</span>
<span class="fn">MESH\_SHADER\_TRIANGLE\_ATTRIBUTES</span>(NANITE\_MESH\_SHADER\_TG\_SIZE)
<span class="kw">void</span> <span class="fn">HWRasterizeMS</span>(
    <span class="ty">uint</span>  GroupThreadID : <span class="ty">SV\_GroupThreadID</span>,
    <span class="ty">uint3</span> GroupID       : <span class="ty">SV\_GroupID</span>,
    <span class="fn">MESH\_SHADER\_VERTEX\_EXPORT</span>(VSOut, <span class="num">256</span>),                  <span class="cm">// 정점 출력</span>
    <span class="fn">MESH\_SHADER\_TRIANGLE\_EXPORT</span>(<span class="num">128</span>),                       <span class="cm">// 인덱스 출력</span>
    <span class="fn">MESH\_SHADER\_PRIMITIVE\_EXPORT</span>(PrimitiveAttributesPacked, <span class="num">128</span>)) <span class="cm">// per-primitive</span>
{
    <span class="ty">uint</span> DrawClusterIndex = <span class="fn">GetUnWrappedDispatchGroupId</span>(GroupID); <span class="cm">// 64k 한계 우회</span>
    FClusterRef ClusterRef = <span class="fn">FetchClusterRef</span>\&lt;<span class="kw">true</span>\&gt;(DrawClusterIndex); <span class="cm">// 클러스터 fetch</span>
    ...
    <span class="ty">uint</span> TriIndex = TriRange.Start + GroupThreadID;     <span class="cm">// 스레드 1개 = 삼각형 1개</span>
    VertIndexes = <span class="fn">DecodeTriangleIndices</span>(Cluster, TriIndex); <span class="cm">// 압축 데이터에서 인덱스 해제</span>

&#x20;   <span class="fn">SetMeshOutputCounts</span>(NumUniqueVerts, TriRange.Num);  <span class="cm">// ① 개수 먼저 선언</span>

    <span class="fn">MESH\_SHADER\_WRITE\_TRIANGLE</span>(idx, VertIndexes);
    <span class="cm">// per-primitive 속성에 "어느 클러스터의 어느 삼각형"을 패킹</span>
    <span class="ty">uint</span> PixelValue = <span class="fn">PackVisPixelX</span>(ClusterRef.VisibleIndex, TriIndex);
    <span class="fn">MESH\_SHADER\_WRITE\_PRIMITIVE</span>(idx, AttributesPacked);
    <span class="cm">// 정점 변환 결과 쓰기</span>
    VSOut v = <span class="fn">CommonRasterizerVS</span>(NaniteView, ..., Cluster, LaneVertIndex, ...);
    <span class="fn">MESH\_SHADER\_WRITE\_VERTEX</span>(idx, v);

}</div>

<p>
앞 절에서 본 골격과 정확히 일치한다. <strong>GroupID로 클러스터를 집어오고(데이터 직접 fetch), <code>SetMeshOutputCounts</code>로 개수를 선언한 뒤, 정점·삼각형·per-primitive 속성을 그룹이 협력해 출력</strong>한다. Nanite가 영리한 부분은 <strong>per-primitive 속성</strong>이다. 삼각형마다 "이 픽셀은 VisibleIndex 클러스터의 TriIndex번째 삼각형"이라는 ID를 실어 보내 VisBuffer에 기록한다 — 나중에 머티리얼을 한 번에 처리하는 deferred 방식의 출발점이다.
</p>

<div class="callout callout-warn">
<div class="callout-title">코드 속 함정 하나</div>
<p>실제 소스 주석에 이런 경고가 있다: <em>"<code>SetMeshOutputCounts</code> 주변에서 단순 early-out(분기 탈출)을 하면 안 된다. 조건이 그룹 전체에 균일해도 발산(divergent) 제어 흐름이면 컴파일은 되는데 화면이 깨진다."</em> Mesh Shader의 출력 카운트 선언이 그룹 동기 지점이라 그렇다 — 실전 mesh shader 작성의 미묘함을 보여주는 대목.</p>
</div>
</div>

## ② 언제 mesh shader를 쓰나 — Tier1 필요

<div class="ms-post">
<div class="code-block"><span class="code-lang">NaniteShared.cpp (요약)</span><span class="kw">bool</span> <span class="fn">UseMeshShader</span>(EShaderPlatform Platform, ERasterPipeline Pipeline)
{
    <span class="kw">if</span> (!<span class="fn">GetSupportsMeshShadersTier1</span>(Platform)) <span class="kw">return</span> <span class="kw">false</span>; <span class="cm">// Tier1 필수</span>
    <span class="kw">if</span> (!<span class="fn">NaniteMeshShadersSupported</span>(Platform)) <span class="kw">return</span> <span class="kw">false</span>;
    <span class="cm">// per-primitive 속성을 쓰려면 Tier1이 필요하다 (주석)</span>
    <span class="kw">return</span> CVarNaniteMeshShaderRasterization \&amp;\&amp; GRHISupportsMeshShadersTier1 \&amp;\&amp; ...;
}</div>

<p>
Nanite가 mesh shader를 쓰려면 <strong>Mesh Shader Tier1</strong> 지원이 필수다. 이유는 명확하다 — 위에서 본 <strong>per-primitive 속성</strong>(삼각형 ID 패킹)을 쓰기 때문. Tier0만으로는 부족하다. 안 되는 하드웨어를 위해 Nanite는 단계적 폴백 체인을 갖는다.
</p>

<div class="flow-row">
<div class="flow-step prog"><div class="step-num">1순위</div><div class="step-name">Mesh<br>Shader</div><div class="step-desc">Tier1 HW</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step prog"><div class="step-num">2순위</div><div class="step-name">Primitive<br>Shader</div><div class="step-desc">AMD 계열</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step prog"><div class="step-num">3순위</div><div class="step-name">Vertex<br>Shader</div><div class="step-desc">전통 경로</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step prog"><div class="step-num">소삼각형</div><div class="step-name">SW Compute<br>Raster</div><div class="step-desc">MicropolyRasterize</div></div>
</div>

<div class="callout callout-purple">
<div class="callout-title">한 가지 반전: Nanite는 Amplification Shader를 쓰지 않는다</div>
<p>06절에서 Task Shader가 클러스터 컬링에 딱 맞는 도구처럼 보였지만, Nanite의 메인 래스터 경로는 <strong>Amplification(Task) Shader를 쓰지 않는다.</strong> 클러스터 컬링(절두체·오클루전·LOD)을 mesh 파이프라인 안의 task 단계가 아니라 <strong>별도의 독립 컴퓨트 패스</strong>(Persistent Culling)에서 먼저 끝내고, 살아남은 클러스터 목록을 mesh shader에 indirect로 넘긴다. "왜 task shader 대신 compute로 컬링하나"는 Nanite 설계의 흥미로운 선택인데, 계층적 클러스터 트리 순회 같은 복잡한 컬링을 task shader의 제약 안에 욱여넣기보다 범용 컴퓨트로 푸는 게 더 유연하기 때문이다.</p>
</div>
</div>

## ③ UE5.8 전수조사 — mesh shader는 실제로 어디에 쓰이나

<div class="ms-post">
<p>
이 글을 쓰며 <strong>UE 5.8 소스</strong>에서 mesh shader를 실제로 authoring하는 곳을 파일·라인 단위로 전수조사했다. 결과는 <strong>"거의 안 쓴다"</strong>는 통념을 정확히 뒷받침한다 — mesh shader는 사실상 Nanite에 갇혀 있고, <strong>amplification(task) shader는 단 한 줄도 작성돼 있지 않다.</strong>
</p>

<div style="overflow-x:auto;margin:20px 0;">
<table class="cmp">
<thead><tr><th>셰이더 파일</th><th>엔트리 / 클래스</th><th>용도</th><th>기본값</th></tr></thead>
<tbody>
<tr><td><code>Nanite/NaniteRasterizer.usf</code></td><td><code>HWRasterizeMS</code></td><td>Nanite 불투명 HW 래스터 (메인)</td><td>ON (Tier1)</td></tr>
<tr><td><code>Nanite/NaniteTranslucency.usf</code></td><td>반투명 mesh 경로</td><td>Nanite 반투명</td><td>ON (Tier0)</td></tr>
<tr><td><code>BasePassVertexShader.usf</code></td><td><code>Main</code> (<code>SF\_Mesh</code> · <code>TBasePassMS</code>)</td><td>일반 베이스 패스 mesh 경로</td><td>VF 게이트\*</td></tr>
<tr><td><code>HairStrands/RenderCurveRaster.usf</code></td><td>헤어 스트랜드 래스터</td><td>실험적</td><td>OFF (<code>r.RenderCurve=0</code>)</td></tr>
</tbody>
</table>
</div>
<p style="font-size:12.5px;color:var(--text3);">\* 나머지 매치(<code>\*Common.ush</code>)는 <code>SetMeshOutputCounts</code>·<code>DispatchMesh</code> 같은 매크로 정의일 뿐 사용처가 아니다.</p>

<div class="callout callout-purple">
<div class="callout-title">핵심 반전 — "일반 베이스 패스" 경로의 정체</div>
<p><code>BasePassVertexShader.usf</code>에는 Nanite와 무관한 <strong>범용 mesh shader 경로(<code>TBasePassMS</code>)가 코드로 완성</strong>돼 있다. 그런데 이게 켜지려면 vertex factory가 <code>SupportsMeshShading</code> 플래그를 세워야 하는데 — <strong>엔진 전체에서 그 플래그를 켜는 VF는 Nanite 반투명(<code>NaniteTranslucency.cpp:133</code>) 단 하나뿐이다.</strong> LocalVertexFactory(스태틱 메시)·GPUSkin(스켈레탈) 등 주류 VF는 아무도 안 켠다. 즉 "범용처럼 보이는" 베이스 패스 mesh 경로조차 <strong>실효적으로 Nanite만 태운다.</strong></p>
</div>

<div class="callout callout-warn">
<div class="callout-title">Amplification(Task) Shader — 완전히 비어 있음</div>
<p><code>DispatchMesh</code>·<code>AMPLIFICATION\_SHADER\_\*</code>는 D3D/Vulkan/Metal <code>\*Common.ush</code>의 <strong>매크로 정의에만</strong> 존재한다. <strong>authoring된 amplification 셰이더는 0개.</strong> RHI에 <code>SF\_Amplification</code>·<code>RHIDispatchMeshShader</code>는 있지만 정작 호출하는 셰이더가 없다(Metal은 <code>NOT\_SUPPORTED</code>).</p>
</div>

<p>
정리하면 — NVIDIA가 그린 mesh shading의 그림에서 <strong>UE가 실제로 쓰는 건 "mesh" 절반뿐, 그것도 Nanite 안에서만</strong>이다. 진짜 간판 기능인 <strong>amplification 단계(변환 전 GPU 컬링·확장)는 통째로 비어 있고</strong>, 그 일은 Nanite가 별도 컴퓨트 패스로 대신한다. mesh shader가 "프로그래머블 컬링 프론트엔드"가 아니라 <strong>"이미 추려진 클러스터를 HW 래스터라이저에 먹이는 통로"</strong>로만 쓰이는 이유다.
</p>

<div class="callout callout-warn">
<div class="callout-title">한계 — 왜 mesh shader 채택이 느린가</div>
<p>mesh shader는 공짜가 아니다. <strong>① 지오메트리 툴체인을 갈아엎어야</strong> 한다 — 모든 메시를 오프라인에 meshlet으로 빌드하고, 인덱스 버퍼 기반 자산 파이프라인을 바꿔야 한다. <strong>② 하드웨어 파편화</strong> — Tier0/Tier1로 갈리고 구형 GPU·일부 모바일은 미지원이라, 결국 전통 VS 경로를 폴백으로 <em>병행 유지</em>해야 한다(코드 두 벌). <strong>③ 작은 배치엔 이득이 적거나 손해</strong> — 삼각형이 적은 드로우나 amplification 오버헤드가 클 땐 전통 경로가 더 빠를 수 있다. 그래서 mesh shader는 "모든 렌더링의 기본"이 아니라 <strong>지오메트리 밀도가 극단적인 시스템(=Nanite)에서만 본전을 뽑는</strong> 특수 도구에 가깝고, 이것이 UE를 포함한 업계 채택이 더딘 이유다.</p>
</div>

<span class="section-eyebrow">08 — 정리</span>

</div>

# 정리: 하나의 일관된 흐름

<div class="ms-post">
<p>
이 글의 다섯 단계는 사실 <strong>"고정함수를 하나씩 프로그래머블로 바꿔온 역사"</strong>라는 단일 서사다.
</p>

<div class="step-block s1">
<h4>전통 파이프라인</h4>
<p>VS·PS는 프로그래머블이지만, <strong>입력 조립(IA)과 지오메트리 공급은 고정</strong>. GS는 유연했지만 순서 보장 때문에 느려 실패했다.</p>
</div>
<div class="step-block s2">
<h4>컴퓨트 / Dispatch</h4>
<p>"고정 입력 없이 내가 스레드를 띄워 내가 데이터를 읽는다"는 자유. 다만 래스터라이저와 단절돼 있었다.</p>
</div>
<div class="step-block s3">
<h4>GPU-driven 렌더링</h4>
<p>CPU 제출의 스케일 한계를 깨려 <strong>컬링·Draw 목록 생성을 GPU로</strong>. 하지만 실제 그리기는 여전히 고정 프론트엔드를 통과했다.</p>
</div>
<div class="step-block s4">
<h4>Mesh + Amplification Shader</h4>
<p>마지막 고정 조각인 프론트엔드를 컴퓨트 모델로 교체. meshlet 단위로 <strong>정점·프리미티브를 직접 출력</strong>하고, Task 단계에서 <strong>띄울 양 자체를 동적으로 결정·컬링</strong>한다. <code>ExecuteIndirect(DISPATCH\_MESH)</code>로 GPU-driven과도 합쳐진다.</p>
</div>

<p>
그리고 Nanite는 이 그림의 살아있는 증거다. 128삼각형 클러스터(=meshlet)를 mesh shader 그룹 하나로 그리고, per-primitive 속성으로 삼각형 ID를 실어 보내며, 안 되는 하드웨어엔 컴퓨트 소프트웨어 래스터라이저로 폴백한다. <strong>"고정함수를 컴퓨트로 다시 쓴다"</strong>는 mesh shader의 정신을, Nanite는 컬링까지 컴퓨트로 빼는 방식으로 한 발 더 밀고 나간 셈이다.
</p>

<div class="step-block s5">
<h4>그리고 다음은 Work Graphs</h4>
<p>2000년대에는 수천 개의 Draw Call만으로도 대부분의 게임을 표현할 수 있었다. 하지만 장면이 점점 복잡해지면서 CPU가 모든 렌더링 명령을 생성하는 방식은 한계에 부딪혔고, GPU는 단순히 삼각형을 그리는 장치를 넘어 스스로 컬링하고, 작업을 생성하며, 렌더링을 조직하는 <strong>GPU-driven</strong> 방향으로 진화하기 시작했다.</p>
<p>Mesh Shader 역시 이러한 흐름 위에 있는 기술이다. 단순히 Vertex Shader나 Geometry Shader를 대체하는 새로운 API가 아니라, GPU의 지오메트리 프론트엔드까지 프로그래머블하게 만들어 개발자에게 더 많은 제어권을 넘겨준 변화라고 볼 수 있다.</p>
<p>앞으로의 GPU 역시 단순히 삼각형을 그리는 장치가 아니라, 데이터를 해석하고 작업을 생성하며, 렌더링 자체를 스스로 조직하는 방향으로 계속 진화해 갈 가능성이 크다. 그 다음 흐름은 <a href="https://developer.nvidia.com/blog/advancing-gpu-driven-rendering-with-work-graphs-in-direct3d-12/">Work Graphs</a>다.</p>
</div>

<span class="section-eyebrow">참고자료</span>

<ul class="ref-list">
  <li><span class="ref-tag">\[1차]</span> NVIDIA, <em>"Introduction to Turing Mesh Shaders"</em> (task+mesh 2단계 파이프라인, meshlet 64/126, 컴퓨트 모델, 64K children). <a href="https://developer.nvidia.com/blog/introduction-turing-mesh-shaders/">developer.nvidia.com</a></li>
  <li><span class="ref-tag">\[스펙]</span> Microsoft, <em>"Mesh Shader"</em> DirectX-Specs (IA 비활성, 그룹 ≤128 스레드, 출력 ≤256·256, <code>SetMeshOutputCounts</code>·<code>DispatchMesh</code>, payload 16KB). <a href="https://microsoft.github.io/DirectX-Specs/d3d/MeshShader.html">microsoft.github.io/DirectX-Specs</a></li>
  <li><span class="ref-tag">\[스펙]</span> Microsoft, <em>"Coming to DirectX 12: Mesh Shaders and Amplification Shaders"</em> · <em>"Indirect Drawing"</em>(<code>DISPATCH\_MESH</code>, ExecuteIndirect, GPU 컬링). <a href="https://devblogs.microsoft.com/directx/coming-to-directx-12-mesh-shaders-and-amplification-shaders-reinventing-the-geometry-pipeline/">devblogs.microsoft.com</a></li>
  <li><span class="ref-tag">\[스펙]</span> Khronos, <em>"Mesh Shading for Vulkan"</em> (<code>VK\_EXT\_mesh\_shader</code>, task/mesh 스테이지). <a href="https://www.khronos.org/blog/mesh-shading-for-vulkan">khronos.org</a></li>
  <li><span class="ref-tag">\[실무]</span> AMD GPUOpen, <em>"Mesh Shaders: Optimization and Best Practices"</em> (RDNA 128/256, Amp당 ≥32 mesh 그룹). <a href="https://gpuopen.com/learn/mesh\_shaders/mesh\_shaders-optimization\_and\_best\_practices/">gpuopen.com</a></li>
  <li><span class="ref-tag">\[다음]</span> NVIDIA, <em>"Advancing GPU-Driven Rendering with Work Graphs in Direct3D 12"</em> (GPU가 작업을 생성하고 연결하는 Work Graphs). <a href="https://developer.nvidia.com/blog/advancing-gpu-driven-rendering-with-work-graphs-in-direct3d-12/">developer.nvidia.com</a></li>
  <li><span class="ref-tag">\[배경]</span> Josh Barczak, <em>"Why Geometry Shaders Are Slow (Unless you're Intel)"</em> (GS 출력 순서 보장 → 병렬성 붕괴). <a href="http://www.joshbarczak.com/blog/?p=667">joshbarczak.com</a></li>
  <li><span class="ref-tag">\[강연]</span> Brian Karis, Rune Stubbe, Graham Wihlidal, <em>"A Deep Dive into Nanite Virtualized Geometry"</em>, SIGGRAPH 2021 Advances in Real-Time Rendering (128삼각형 클러스터, HW/SW 래스터 분기). <a href="https://advances.realtimerendering.com/s2021/">advances.realtimerendering.com/s2021</a></li>
  <li><span class="ref-tag">\[소스]</span> Unreal Engine 5.7.4 / 5.8 — <code>NaniteRasterizer.usf</code>(<code>HWRasterizeMS</code>), <code>NaniteShared.cpp</code>(<code>UseMeshShader</code>·<code>GetRasterHardwarePath</code>), <code>BasePassVertexShader.usf</code>(<code>TBasePassMS</code>), <code>NaniteTranslucency.cpp</code></li>
</ul>

</div>
