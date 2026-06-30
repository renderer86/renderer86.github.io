---

layout: post
title: "UE5 Async Compute: RDG는 어떻게 모든 패스를 자동으로 비동기로 돌리나"
icon: paper
permalink: asynccompute
categories: Rendering
tags: [Rendering, UnrealEngine, AsyncCompute, RDG, GPU]
excerpt: "async compute가 GPU의 노는 ALU를 어떻게 메우는지, occupancy와 VGPR/SGPR이 그 한계를 어떻게 정하는지, UE4에서 손으로 fence를 걸던 일을 UE5 RDG가 fork/join으로 어떻게 자동화했는지, 그리고 왜 async를 켜도 GPU 시간이 1~2ms밖에 안 줄어드는지를 UE5 소스를 따라가며 분석한다."
back_color: "#ffffff"
img_name: "asynccompute.webp"
toc: false
show: true
new: true
series: -1
index: 13
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - "async compute가 켜져 있다는데 대체 뭐가 비동기인가?"가 궁금한 분
> - UE4 시절엔 compute fence를 직접 걸었는데 UE5에서는 그게 다 어디 갔는지 찾는 분
> - RDG가 어떻게 패스를 자동으로 async 파이프로 보내는지 코드 수준에서 보고 싶은 분
> - async를 켜도 왜 GPU 시간이 1~2ms밖에 안 줄어드는지 근본 이유를 알고 싶은 분
> - occupancy·VGPR·SGPR이 "동시 실행"의 천장을 어떻게 정하는지 정리하고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - async compute = 별도 하드웨어 큐로, graphics가 놀리는 실행 유닛을 메우는 것
> - GPU가 "왜 노는가" — occupancy와 VGPR/SGPR 레지스터 파일의 관계
> - <code>ERDGPassFlags::AsyncCompute</code> 한 줄이 패스를 <code>ERHIPipeline::AsyncCompute</code>로 보내는 경로
> - RDG가 cross-pipeline producer/consumer를 추적해 <strong>fork/join 펜스를 자동 삽입</strong>하는 알고리즘
> - <code>r.RDG.AsyncCompute</code>의 0/1/2 정책과 "거의 모든 패스가 async"처럼 보이는 이유
> - async가 만점(100% 활용)을 못 내는 이유 — CU 자원 공유, 캐시 thrashing, 대역폭 경합, fence stall

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
.ac-post {
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
.ac-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.ac-post .card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin: 24px 0;
}
.ac-post .card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.ac-post .card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
}
.ac-post .card.blue::before   { background: var(--accent); }
.ac-post .card.gold::before   { background: var(--gold); }
.ac-post .card.teal::before   { background: var(--teal); }
.ac-post .card.coral::before  { background: var(--coral); }
.ac-post .card.purple::before { background: var(--accent2); }
.ac-post .card.orange::before { background: var(--orange); }
.ac-post .card-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.ac-post .card.blue   .card-label { color: var(--accent); }
.ac-post .card.gold   .card-label { color: var(--gold); }
.ac-post .card.teal   .card-label { color: var(--teal); }
.ac-post .card.coral  .card-label { color: var(--coral); }
.ac-post .card.purple .card-label { color: var(--accent2); }
.ac-post .card.orange .card-label { color: var(--orange); }
.ac-post .card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}
.ac-post .card-desc {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.65;
  margin: 0;
}
.ac-post .callout {
  border-radius: 12px;
  padding: 16px 20px;
  margin: 20px 0;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.ac-post .callout::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}
.ac-post .callout-info { background: rgba(61,99,224,0.05); border-color: rgba(61,99,224,0.18); }
.ac-post .callout-info::before { background: var(--accent); }
.ac-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); }
.ac-post .callout-warn::before { background: var(--gold); }
.ac-post .callout-teal { background: rgba(10,143,98,0.05); border-color: rgba(10,143,98,0.20); }
.ac-post .callout-teal::before { background: var(--teal); }
.ac-post .callout-coral { background: rgba(214,48,49,0.05); border-color: rgba(214,48,49,0.20); }
.ac-post .callout-coral::before { background: var(--coral); }
.ac-post .callout-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.ac-post .callout-info .callout-title { color: var(--accent); }
.ac-post .callout-warn .callout-title { color: var(--gold); }
.ac-post .callout-teal .callout-title { color: var(--teal); }
.ac-post .callout-coral .callout-title { color: var(--coral); }
.ac-post .callout p { margin: 0; font-size: 13px; color: var(--text2); line-height: 1.75; }
.ac-post .callout p + p { margin-top: 8px; }
.ac-post .code-block {
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
.ac-post .code-block .kw  { color: #a78bfa; }
.ac-post .code-block .fn  { color: #34d399; }
.ac-post .code-block .cm  { color: #525a78; font-style: italic; }
.ac-post .code-block .num { color: #fb923c; }
.ac-post .code-block .str { color: #fbbf24; }
.ac-post .code-block .ty  { color: #38bdf8; }
.ac-post .code-lang {
  position: absolute;
  top: 10px; right: 14px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #525a78;
}
.ac-post .flow-row {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin: 24px 0;
  overflow-x: auto;
}
.ac-post .flow-step {
  flex: 1;
  min-width: 130px;
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 14px 16px;
  position: relative;
  text-align: center;
}
.ac-post .flow-step .step-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text3);
  margin-bottom: 4px;
}
.ac-post .flow-step .step-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}
.ac-post .flow-step .step-desc {
  font-size: 11px;
  color: var(--text2);
  line-height: 1.5;
}
.ac-post .flow-arrow {
  display: flex;
  align-items: center;
  padding: 0 6px;
  color: var(--text3);
  font-size: 18px;
  flex-shrink: 0;
}
.ac-post .step-block {
  border-left: 3px solid var(--border2);
  padding: 16px 20px;
  margin: 16px 0;
  background: var(--surface);
  border-radius: 0 10px 10px 0;
}
.ac-post .step-block.s1 { border-color: var(--coral); }
.ac-post .step-block.s2 { border-color: var(--gold); }
.ac-post .step-block.s3 { border-color: var(--teal); }
.ac-post .step-block.s4 { border-color: var(--accent); }
.ac-post .step-block h4 {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 6px;
}
.ac-post .step-block.s1 h4 { color: var(--coral); }
.ac-post .step-block.s2 h4 { color: var(--gold); }
.ac-post .step-block.s3 h4 { color: var(--teal); }
.ac-post .step-block.s4 h4 { color: var(--accent); }
.ac-post .step-block p {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.75;
  margin: 0 0 8px 0;
}
.ac-post .step-block p:last-child { margin-bottom: 0; }
.ac-post .flag-badge {
  display: inline-block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 5px;
  letter-spacing: 0.03em;
}
.ac-post .flag-blue   { background: rgba(61,99,224,0.12);  color: var(--accent); }
.ac-post .flag-coral  { background: rgba(214,48,49,0.12);  color: var(--coral); }
.ac-post .flag-teal   { background: rgba(10,143,98,0.12);  color: var(--teal); }
.ac-post .flag-gold   { background: rgba(176,125,0,0.12);  color: var(--gold); }
.ac-post .flag-purple { background: rgba(114,72,212,0.12); color: var(--accent2); }
.ac-post .ac-table-wrap { overflow-x: auto; margin: 24px 0; }
.ac-post table.ac-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.ac-post table.ac-table th {
  padding: 10px 14px;
  border: 1px solid var(--border);
  color: var(--text3);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-align: left;
  background: var(--surface2);
}
.ac-post table.ac-table td {
  padding: 9px 14px;
  border: 1px solid var(--border);
  color: var(--text2);
  line-height: 1.6;
}
.ac-post table.ac-table tr:nth-child(even) td { background: var(--surface); }
.ac-post table.ac-table tr:nth-child(odd) td { background: #fff; }
.ac-post table.ac-table code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--accent);
}
.ac-post p.body { color: var(--text2); line-height: 1.85; }
.ac-post .body code, .ac-post li code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  color: var(--accent);
  background: rgba(61,99,224,0.06);
  padding: 1px 5px;
  border-radius: 4px;
}

/* --- 두 파이프 타임라인 --- */
.ac-post .timeline {
  margin: 26px 0;
  border: 1px solid var(--border2);
  border-radius: 12px;
  padding: 18px 18px 14px;
  background: var(--surface);
  overflow-x: auto;
}
.ac-post .tl-lane {
  display: flex;
  align-items: stretch;
  gap: 4px;
  margin-bottom: 8px;
  min-width: 560px;
}
.ac-post .tl-label {
  flex: 0 0 96px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
}
.ac-post .tl-label.gfx   { color: var(--accent); }
.ac-post .tl-label.async { color: var(--teal); }
.ac-post .tl-blk {
  border-radius: 6px;
  padding: 8px 6px;
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1.25;
}
.ac-post .tl-blk.gfx    { background: var(--accent); }
.ac-post .tl-blk.gfx2   { background: #6f8ae8; }
.ac-post .tl-blk.async  { background: var(--teal); }
.ac-post .tl-idle  { background: repeating-linear-gradient(45deg, #e6e9f4, #e6e9f4 6px, #dfe3f0 6px, #dfe3f0 12px); color: var(--text3); border: 1px dashed var(--border2); }
.ac-post .tl-cap {
  font-size: 11px;
  color: var(--text3);
  margin-top: 6px;
  font-style: italic;
}
.ac-post .tl-fence {
  flex: 0 0 16px;
  background: var(--gold);
  border-radius: 3px;
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  writing-mode: vertical-rl;
  text-orientation: upright;
  display: flex;
  align-items: center;
  justify-content: center;
  letter-spacing: -1px;
}

/* --- occupancy 바 --- */
.ac-post .occ-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin: 24px 0;
}
.ac-post .occ-card {
  border: 1px solid var(--border2);
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--surface);
}
.ac-post .occ-head {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}
.ac-post .occ-sub {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text3);
  margin-bottom: 12px;
}
.ac-post .occ-slots {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ac-post .occ-slot {
  width: 22px; height: 14px;
  border-radius: 3px;
  background: var(--surface2);
  border: 1px solid var(--border);
}
.ac-post .occ-slot.on  { background: var(--teal); border-color: var(--teal); }
.ac-post .occ-slot.onb { background: var(--accent); border-color: var(--accent); }
.ac-post .occ-note { font-size: 11.5px; color: var(--text2); margin-top: 10px; line-height: 1.6; }
</style>

<div class="ac-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# Async Compute 개요

<div class="ac-post">
<p class="body">
GPU는 한 프레임 안에서 생각보다 자주 <strong>논다.</strong> 그림자 맵을 그릴 때처럼 삼각형 처리(지오메트리·래스터)에 발이 묶이면 셰이더 ALU는 텅 비고, 후처리처럼 메모리 대역폭에 발이 묶이면 이번엔 연산 유닛이 논다. <strong>async compute</strong>는 이 빈틈에 다른 성격의 연산 작업을 끼워 넣어 GPU를 더 채우는 기법이다. 핵심은 "두 개의 독립된 하드웨어 큐(graphics / compute)에 일을 따로 넣어 <em>동시에</em> 굴린다"는 것 하나다.
</p>

<p class="body">
UE4 시절엔 이걸 쓰려면 <strong>개발자가 직접</strong> compute fence를 만들어 "여기서 갈라지고(fork) 여기서 다시 합쳐라(join)"를 손으로 코딩해야 했다. 그래서 보통은 자기가 새로 추가한 compute 패스 하나 정도만 async로 돌렸다. UE5에서는 <strong>RDG(Render Dependency Graph)</strong>가 패스 의존 그래프 전체를 알고 있기 때문에, 패스에 플래그 하나만 달면 fork/join 펜스를 <strong>알아서 끼워 준다.</strong> 그 결과 Lumen·Nanite·TSR·SSAO… 엔진의 수많은 서브시스템이 기본값으로 async를 켜고, 마치 "거의 모든 패스가 async로 도는" 것처럼 보이게 됐다.
</p>

<div class="callout callout-info">
<div class="callout-title">한 문장 요약</div>
<p>async compute는 GPU가 <strong>놀고 있는 실행 유닛</strong>을 다른 큐의 일로 메우는 것이다. UE5 RDG는 그래프에서 <strong>cross-pipeline 의존성</strong>을 읽어 fork/join 펜스를 자동으로 삽입한다 — 그래서 손으로 안 짜도 된다. 다만 두 큐가 <strong>같은 물리 자원(레지스터·캐시·대역폭)</strong>을 나눠 쓰므로, 켠다고 GPU가 공짜로 2배가 되진 않는다. 보통 1~2ms.</p>
</div>

<span class="section-eyebrow">01 — async compute란</span>

</div>

# async compute란 무엇인가

<div class="ac-post">
<p class="body">
현대 GPU는 명령을 받는 입구가 하나가 아니다. 그래픽 API는 이걸 <strong>큐(queue) / 엔진(engine)</strong>으로 추상화한다. 보통 세 종류다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">DIRECT / GRAPHICS</div>
<div class="card-title">그래픽 큐</div>
<div class="card-desc">draw·dispatch·copy 전부 가능한 만능 큐. 래스터 파이프라인은 여기서만 돈다. GPU엔 보통 지오메트리 프론트엔드가 하나뿐이라, 그래픽 큐를 여러 개 만들어도 이득이 없다.</div>
</div>
<div class="card teal">
<div class="card-label">COMPUTE</div>
<div class="card-title">컴퓨트 큐 (async)</div>
<div class="card-desc">compute shader dispatch와 로컬 메모리 연산 전용. graphics 큐와 <strong>병렬로</strong> 스케줄된다. 여기에 일을 넣는 게 곧 "async compute".</div>
</div>
<div class="card gold">
<div class="card-label">COPY / DMA</div>
<div class="card-title">복사 큐</div>
<div class="card-desc">PCIe를 통한 DMA 전송 전용. 업로드·다운로드를 렌더링과 겹치는 데 쓴다. (이 글의 주제는 아니다.)</div>
</div>
</div>

<p class="body">
중요한 건 "큐가 여러 개"라는 사실 자체가 아니라, <strong>이 큐들이 같은 물리 GPU 위에서 동시에 진행될 수 있다</strong>는 점이다. graphics 큐가 어떤 패스에서 실행 유닛을 다 못 쓰고 있을 때, compute 큐의 dispatch가 그 빈 유닛으로 흘러 들어가 함께 돈다. AMD GPUOpen의 표현을 빌리면, async compute는 매 프레임 동기화 지점과 배리어 때문에 생기는 <strong>"그래프 상의 빈틈(gaps)을 메워 추가 성능을 낸다."</strong>
</p>

<div class="callout callout-warn">
<div class="callout-title">"비동기"가 뜻하는 것 — CPU 비동기가 아니다</div>
<p>여기서 async는 <strong>CPU 스레드 비동기가 아니라 GPU 큐 사이의 비동기</strong>다. 두 큐는 명시적으로 펜스로 동기화하기 전까지 서로의 진행 순서를 보장하지 않는다. 그래서 데이터를 주고받는 지점마다 펜스가 필요하고, 그 펜스를 어디에 두느냐가 이 글의 절반(RDG)이다.</p>
</div>

<p class="body">
그림으로 보면 직관적이다. 직렬로 돌리면 그림자 패스가 끝나야 GTAO가 시작하지만, async로 돌리면 그림자 패스가 노는 ALU 위에서 GTAO가 같이 돈다.
</p>

<div class="timeline">
<div class="tl-lane">
<div class="tl-label gfx">직렬</div>
<div class="tl-blk gfx" style="flex: 4">Shadow Depth (지오메트리 bound, ALU 놀고 있음)</div>
<div class="tl-blk gfx2" style="flex: 3">GTAO (compute)</div>
</div>
<div class="tl-cap">▲ Shadow가 끝날 때까지 GTAO는 대기 — 전체 = 두 패스의 합</div>
<div class="tl-lane" style="margin-top:16px">
<div class="tl-label gfx">GFX 큐</div>
<div class="tl-blk gfx" style="flex: 4">Shadow Depth</div>
<div class="tl-blk tl-idle" style="flex: 3">…다음 graphics 패스 대기…</div>
</div>
<div class="tl-lane">
<div class="tl-label async">ASYNC 큐</div>
<div class="tl-fence">F</div>
<div class="tl-blk async" style="flex: 4">GTAO — Shadow의 빈 ALU 위에서 동시 실행</div>
</div>
<div class="tl-cap">▲ async — GTAO가 Shadow와 겹친다. 전체 ≈ 더 긴 쪽 + 펜스(F) 비용</div>
</div>

<p class="body">
좋은 짝은 <strong>병목이 서로 다른</strong> 두 패스다. AMD는 "depth-only 렌더링 패스는 그 옆에 compute 작업을 끼우기 좋은 후보"이고, "LDS와 ALU를 많이 쓰는 compute shader가 보통 async 큐에 좋은 후보"라고 정리한다. depth/shadow 패스는 ALU가 비어 있고, ALU 무거운 compute는 그 ALU를 채우니 서로 안 부딪힌다. 반대로 둘 다 메모리 대역폭을 쥐어짜는 패스끼리 겹치면 오히려 느려진다 — <strong>왜 그런지가 이 글의 나머지 절반이다.</strong>
</p>

<span class="section-eyebrow">02 — GPU는 왜 노는가</span>

</div>

# GPU는 왜 노는가: occupancy와 VGPR·SGPR

<div class="ac-post">
<p class="body">
async가 "빈틈을 메운다"면, 먼저 <strong>그 빈틈이 왜 생기는지</strong>를 알아야 한다. 답은 <strong>occupancy(점유율)</strong>다. GPU의 연산 단위(AMD는 SIMD, NVIDIA는 SM 안의 스케줄러)는 여러 <strong>wavefront(wave / warp)</strong>를 동시에 올려놓고, 하나가 메모리를 기다리며 멈추면 다른 wave로 즉시 전환해 지연을 숨긴다. 올라간 wave가 많을수록(occupancy가 높을수록) 숨길 거리가 많아 실행 유닛이 덜 논다.
</p>

<div class="callout callout-info">
<div class="callout-title">occupancy의 정의</div>
<p>occupancy = <strong>실제로 올라간 wave 수 / 올릴 수 있는 최대 슬롯 수.</strong> RDNA2+ 기준 SIMD당 슬롯은 16개다. occupancy가 낮으면 "지연을 숨길 다른 wave"가 없어서, wave 하나가 메모리를 기다리는 동안 SIMD가 통째로 논다. 이때 생기는 빈 ALU가 바로 async compute가 노리는 자리다.</p>
</div>

<p class="body">
그런데 wave를 몇 개나 올릴 수 있는지는 <strong>레지스터 파일</strong>이 정한다. 여기서 VGPR·SGPR이 등장한다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">VGPR</div>
<div class="card-title">Vector GPR — 레인마다 다른 값</div>
<div class="card-desc">wave 안 64개(또는 32개) 스레드가 <strong>각자</strong> 갖는 값. 픽셀 좌표, 보간된 UV처럼 스레드마다 다른 데이터. VALU가 직접 다룬다. 거의 항상 <strong>occupancy의 진짜 병목.</strong></div>
</div>
<div class="card purple">
<div class="card-label">SGPR</div>
<div class="card-title">Scalar GPR — wave 전체가 공유</div>
<div class="card-desc">컴파일 타임에 wave 전체에서 균일함이 보장되는 값(상수 버퍼 주소, 루프 카운터 등). RDNA에서는 wave마다 고정 개수가 할당되고 항상 16슬롯을 채울 만큼 충분해서, 보통 병목이 아니다.</div>
</div>
</div>

<p class="body">
레지스터 파일은 <strong>크기가 고정</strong>이다. GCN은 CU의 SIMD마다 64KB(= 32비트 VGPR 16,384개), CU 전체로는 65,536 VGPR. RDNA는 SIMD당 128KB로 늘었고, RDNA4는 192KB까지 커졌다. 이 고정된 파일을 올라간 wave들이 나눠 갖는다. 그러니 <strong>한 wave가 VGPR을 많이 쓸수록 올릴 수 있는 wave가 줄어든다.</strong>
</p>

<div class="ac-table-wrap">
<table class="ac-table">
<thead>
<tr><th>shader가 쓰는 VGPR (RX 7900 XTX, SIMD당 1536 VGPR)</th><th>올릴 수 있는 wave</th><th>결과</th></tr>
</thead>
<tbody>
<tr><td>96 이하</td><td>16 (최대)</td><td>꽉 참 — 지연을 충분히 숨김</td></tr>
<tr><td>120</td><td>1536 / 120 = 12.8 → <strong>12</strong></td><td>슬롯 16개 중 12개만 — 빈 슬롯 발생</td></tr>
<tr><td>118 (살짝 줄임)</td><td><strong>13</strong></td><td>할당 단위 경계 덕에 wave 하나 더</td></tr>
</tbody>
</table>
</div>

<p class="body">
이걸 슬롯 그림으로 보면 이렇다. 레지스터를 적게 쓰는 가벼운 셰이더는 슬롯을 꽉 채워 ALU가 바쁘지만, 레지스터를 많이 쓰는 무거운 셰이더는 슬롯을 절반밖에 못 채워 — <strong>나머지 절반의 ALU 자리가 빈다.</strong>
</p>

<div class="occ-grid">
<div class="occ-card">
<div class="occ-head">가벼운 셰이더 (≤96 VGPR)</div>
<div class="occ-sub">16 / 16 wave · occupancy 100%</div>
<div class="occ-slots">
<div class="occ-slot on"></div><div class="occ-slot on"></div><div class="occ-slot on"></div><div class="occ-slot on"></div>
<div class="occ-slot on"></div><div class="occ-slot on"></div><div class="occ-slot on"></div><div class="occ-slot on"></div>
<div class="occ-slot on"></div><div class="occ-slot on"></div><div class="occ-slot on"></div><div class="occ-slot on"></div>
<div class="occ-slot on"></div><div class="occ-slot on"></div><div class="occ-slot on"></div><div class="occ-slot on"></div>
</div>
<div class="occ-note">지연 숨기기 충분. async를 끼워 넣을 빈자리가 거의 없다.</div>
</div>
<div class="occ-card">
<div class="occ-head">무거운 셰이더 (~120 VGPR)</div>
<div class="occ-sub">12 / 16 wave · occupancy 75%</div>
<div class="occ-slots">
<div class="occ-slot onb"></div><div class="occ-slot onb"></div><div class="occ-slot onb"></div><div class="occ-slot onb"></div>
<div class="occ-slot onb"></div><div class="occ-slot onb"></div><div class="occ-slot onb"></div><div class="occ-slot onb"></div>
<div class="occ-slot onb"></div><div class="occ-slot onb"></div><div class="occ-slot onb"></div><div class="occ-slot onb"></div>
<div class="occ-slot"></div><div class="occ-slot"></div><div class="occ-slot"></div><div class="occ-slot"></div>
</div>
<div class="occ-note">빈 슬롯 4개 → 여기에 async compute의 wave가 들어와 ALU를 채운다. <strong>이게 overlap이 생기는 자리.</strong></div>
</div>
</div>

<div class="callout callout-teal">
<div class="callout-title">LDS(group shared memory)도 같은 식으로 occupancy를 깎는다</div>
<p>VGPR뿐 아니라 <strong>LDS</strong>도 고정 용량을 wave들이 나눠 쓴다. thread group이 LDS를 많이 잡으면 한 WGP/CU에 올라갈 그룹 수가 줄어 occupancy가 떨어진다. compute shader를 짤 때 "큰 thread group + 큰 LDS"가 역효과를 내는 이유이기도 하다.</p>
</div>

<p class="body">
정리하면 — <strong>빈 ALU 슬롯은 "occupancy가 100%가 아니어서" 생긴다.</strong> 그리고 occupancy가 100%가 아닌 이유는 대개 VGPR/LDS를 많이 써서다. async compute는 바로 이 남는 슬롯에 다른 큐의 wave를 밀어 넣는 기법이다. 그런데 — 여기서 8장의 핵심 복선이 깔린다 — <strong>밀어 넣을 wave도 VGPR/LDS를 쓴다.</strong> 빈 슬롯이 4개라도, async 쪽 wave가 레지스터를 너무 많이 쓰면 4개를 다 못 채운다. <strong>"동시 실행의 천장"은 결국 이 레지스터 파일이 정한다.</strong>
</p>

<span class="section-eyebrow">03 — UE4: 손으로 fence를 걸던 시절</span>

</div>

# UE4: 손으로 fence를 걸던 시절

<div class="ac-post">
<p class="body">
UE4에서 async compute는 <strong>저수준 RHI 기능</strong>이었다. 개발자가 직접 <code>FComputeFenceRHIRef</code> 같은 compute fence를 만들고, 명령을 graphics 컨텍스트가 아닌 <strong>async compute 컨텍스트</strong>에 기록한 뒤, "graphics가 이 fence를 기다려라 / async가 저 fence를 기다려라"를 손으로 배치해야 했다. 즉 fork(갈라지는 지점)와 join(합쳐지는 지점)을 사람이 직접 계산해서 코드로 박았다.
</p>

<div class="callout callout-coral">
<div class="callout-title">왜 "새로 추가한 compute 패스 하나만" async로 만들었나</div>
<p>fork/join을 손으로 거는 일은 <strong>위험하고 국소적</strong>이다. 펜스를 한 군데라도 빠뜨리면 read-before-write 레이스가 나서 화면이 깨지거나 GPU가 hang한다. 의존 관계가 바뀌면 펜스 위치도 다시 계산해야 한다. 그래서 현실적으로는 "내가 방금 추가한, 의존 관계가 뻔한 compute 패스" 정도만 async로 돌리고 나머지는 건드리지 않는 게 안전했다. async가 좋은 줄 알면서도 적게 쓴 이유다.</p>
</div>

<p class="body">
문제의 본질은 <strong>"전체 의존 그래프를 코드가 모른다"</strong>는 데 있었다. 어떤 패스 A의 출력이 한참 뒤 패스 B의 입력으로 쓰인다는 사실을, 그걸 짠 사람만 머릿속으로 안다. 그러니 fork/join도 사람이 머리로 계산할 수밖에. <strong>RDG는 정확히 이 "전체 그래프를 코드가 안다"를 해결했고, 그 순간 fork/join 자동화가 가능해졌다.</strong>
</p>

<span class="section-eyebrow">04 — UE5 RDG: 그래프가 fork/join을 자동으로</span>

</div>

# UE5 RDG: 그래프가 fork/join을 자동으로

<div class="ac-post">
<p class="body">
RDG는 한 프레임의 모든 렌더 패스를 <strong>먼저 그래프로 등록</strong>한 뒤(setup), 한꺼번에 컴파일·실행한다. 컴파일 단계에서 RDG는 모든 리소스의 <strong>생산자(producer)와 소비자(consumer)</strong>를 안다. 이 전역 지식이 async 자동화의 전제다.
</p>

<h3 style="font-size:16px;font-weight:700;color:var(--text);margin-top:32px;">① 플래그 한 줄이 파이프를 정한다</h3>

<p class="body">
패스를 async로 보내는 건 플래그 하나다. <code>AddPass(..., ERDGPassFlags::AsyncCompute, ...)</code>. 패스 생성자에서 이 플래그를 보고 그 패스의 파이프라인을 결정한다. (<code>RenderGraphPass.cpp:449</code>)
</p>

<div class="code-block"><span class="code-lang">RenderGraphPass.cpp</span><span class="cm">// 패스의 파이프라인은 플래그 하나로 결정된다</span>
, Pipeline(<span class="fn">EnumHasAnyFlags</span>(Flags, ERDGPassFlags::AsyncCompute)
      ? ERHIPipeline::AsyncCompute
      : ERHIPipeline::Graphics)</div>

<p class="body">
플래그 자체는 비트 하나다. (<code>RenderGraphDefinitions.h</code>) 패스가 이 플래그를 달면 RDG는 그 패스를 <code>ERHIPipeline::AsyncCompute</code> 파이프에 배치한다 — 그게 전부다. 나머지 동기화는 RDG가 한다.
</p>

<div class="code-block"><span class="code-lang">RenderGraphDefinitions.h</span><span class="kw">enum class</span> <span class="ty">ERDGPassFlags</span> : <span class="kw">uint16</span>
{
    <span class="cm">// ...</span>
    <span class="cm">/** Pass uses compute on the async compute pipe. */</span>
    AsyncCompute = <span class="num">1</span> &lt;&lt; <span class="num">2</span>,
    <span class="cm">// ...</span>
};</div>

<h3 style="font-size:16px;font-weight:700;color:var(--text);margin-top:32px;">② cross-pipeline 의존성을 기록한다</h3>

<p class="body">
RDG가 패스 간 의존성을 등록할 때, <strong>두 패스가 서로 다른 파이프</strong>에 있으면 특별 취급한다. 생산자에는 "다른 파이프의 소비자 목록"을, 소비자에는 "다른 파이프의 가장 늦은 생산자"를 기록한다. (<code>RenderGraphBuilder.cpp</code> <code>AddPassDependency</code>)
</p>

<div class="code-block"><span class="code-lang">RenderGraphBuilder.cpp — AddPassDependency</span><span class="kw">if</span> (Producer-&gt;Pipeline != Consumer-&gt;Pipeline)
{
    <span class="cm">// 생산자: 다른 파이프의 소비자들을 정렬해 모아둔다(컬링 대비)</span>
    <span class="fn">BinarySearchOrAdd</span>(Producer-&gt;CrossPipelineConsumers, Consumer-&gt;Handle);

&#x20;   <span class="cm">// 소비자: 다른 파이프의 "가장 늦은" 생산자를 기억한다</span>
    <span class="kw">if</span> (Consumer-&gt;CrossPipelineProducer.IsNull()
        || Producer-&gt;Handle &gt; Consumer-&gt;CrossPipelineProducer)
    {
        Consumer-&gt;CrossPipelineProducer = Producer-&gt;Handle;
    }

}</div>

<p class="body">
이 두 줄이 fork/join 계산의 원재료다. async 패스 입장에서 <code>CrossPipelineProducer</code>는 "내가 시작하려면 graphics 쪽 어디까지 끝나야 하는가(= fork 지점)", <code>CrossPipelineConsumers</code>는 "graphics 쪽 누가 내 결과를 기다리는가(= join 지점)"를 말해 준다.
</p>

<h3 style="font-size:16px;font-weight:700;color:var(--text);margin-top:32px;">③ fork/join 펜스를 자동 삽입한다</h3>

<p class="body">
컴파일 단계에서 async 패스가 하나라도 있으면, RDG는 패스 배열을 <strong>앞으로 한 번, 뒤로 한 번</strong> 훑는다. 앞으로 훑으며 각 async 패스의 <strong>fork 지점</strong>을, 뒤로 훑으며 <strong>join 지점</strong>을 정한다. (<code>RenderGraphBuilder.cpp</code> Compile)
</p>

<div class="step-block s4">
<h4>FORWARD — fork 지점 찾기</h4>
<p>각 async 패스의 fork pass = <strong>max(</strong> 그 패스의 <code>CrossPipelineProducer</code>, 직전 fork 지점, prologue <strong>)</strong>. 즉 "가장 늦은 graphics 생산자"에서 갈라진다. 너무 일찍 갈라지면 데이터가 아직 준비 안 됐고, 이보다 늦으면 안 되니 <strong>가장 늦게(=가장 안전하면서 가장 많이 겹치게)</strong> 잡는다.</p>
</div>

<div class="code-block"><span class="code-lang">RenderGraphBuilder.cpp — fork (forward)</span>FRDGPassHandle GraphicsForkPassHandle = FRDGPassHandle::<span class="fn">Max</span>(
    AsyncComputePass-&gt;CrossPipelineProducer,
    FRDGPassHandle::<span class="fn">Max</span>(CurrentGraphicsForkPassHandle, ProloguePassHandle));

AsyncComputePass->GraphicsForkPass = GraphicsForkPassHandle;
<span class="cm">// fork 지점(graphics) epilogue에 cross-pipe 펜스를 건다</span>
GraphicsForkPass->bGraphicsFork = <span class="num">1</span>;
AsyncComputePass->bAsyncComputeBegin = <span class="num">1</span>;</div>

<div class="step-block s3">
<h4>BACKWARD — join 지점 찾기</h4>
<p>각 async 패스의 join pass = <strong>min(</strong> 컬링 안 된 가장 이른 <code>CrossPipelineConsumer</code>, 다음 join 지점, epilogue <strong>)</strong>. 즉 "가장 먼저 내 결과를 쓰는 graphics 패스" 직전에서 합친다. 그보다 일찍 합치면 겹치는 구간이 짧아져 손해, 늦으면 레이스가 난다.</p>
</div>

<div class="code-block"><span class="code-lang">RenderGraphBuilder.cpp — join (backward)</span>FRDGPassHandle GraphicsJoinPassHandle = FRDGPassHandle::<span class="fn">Min</span>(
    CrossPipelineConsumer,
    FRDGPassHandle::<span class="fn">Min</span>(CurrentGraphicsJoinPassHandle, EpiloguePassHandle));

AsyncComputePass->GraphicsJoinPass = GraphicsJoinPassHandle;
AsyncComputePass->bAsyncComputeEnd = <span class="num">1</span>;
GraphicsJoinPass->bGraphicsJoin = <span class="num">1</span>;</div>

<p class="body">
펜스 자체는 RHI 트랜지션으로 만들어진다. <strong>어느 파이프에서 시작해 어느 파이프에서 끝나는지</strong>를 함께 넣는다 — graphics→async 펜스는 <code>(Graphics, AsyncCompute)</code>, async→graphics 펜스는 <code>(AsyncCompute, Graphics)</code>. 실행 시점에 <code>RHICmdList.BeginTransitions()</code>로 제출된다.
</p>

<div class="code-block"><span class="code-lang">RenderGraphPass.cpp — 펜스 생성</span><span class="cm">// fork 지점의 epilogue 배리어: 현재 파이프 → AsyncCompute 로 건너가는 펜스</span>
EpilogueBarriersToBeginForAsyncCompute = Allocator.<span class="fn">AllocNoDestruct</span>&lt;FRDGBarrierBatchBegin&gt;(
    Pipeline, ERHIPipeline::AsyncCompute, <span class="cm">/*...*/</span>, <span class="kw">this</span>);

<span class="cm">// 실제 RHI 트랜지션: (시작 파이프, 끝 파이프)를 박아 만든다</span>
Transition = <span class="fn">RHICreateTransition</span>(
FRHITransitionCreateInfo(PipelinesToBegin, PipelinesToEnd, <span class="cm">/*...*/</span>));</div>

<p class="body">
즉 UE4에서 사람이 머리로 하던 "fork는 여기, join은 저기, 펜스 거는 거 잊지 말기"를, RDG는 <strong>그래프에 이미 적힌 생산자/소비자 핸들에서 max/min 한 번으로</strong> 기계적으로 뽑아낸다. 패스를 추가하거나 의존이 바뀌어도 다음 프레임 컴파일 때 다시 계산되니 <strong>틀릴 일이 없다.</strong> 이게 "손으로 안 짜도 되는" 이유이자, 엔진이 수많은 패스에 부담 없이 async 플래그를 달 수 있게 된 이유다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">setup</div><div class="step-name">패스 등록</div><div class="step-desc">AsyncCompute 플래그 → 파이프 배치</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">deps</div><div class="step-name">의존성 기록</div><div class="step-desc">CrossPipeline Producer/Consumer</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">compile</div><div class="step-name">fork/join 계산</div><div class="step-desc">forward=max, backward=min</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">execute</div><div class="step-name">펜스 제출</div><div class="step-desc">BeginTransitions로 RHI 동기화</div></div>
</div>

<span class="section-eyebrow">05 — 왜 "거의 모든 패스가 async"처럼 보이나</span>

</div>

# 왜 "거의 모든 패스가 async"처럼 보이나

<div class="ac-post">
<p class="body">
지금의 렌더링 파이프라인을 보면 UE4 대비 지금은 거의 모든 패스가 async로 도는 것 같다라는 생각이 들었다. 두 가지가 겹쳐서 그렇다. <strong>(1)</strong> RDG가 fork/join을 공짜로 해 주니 엔진 서브시스템들이 자기 패스에 async 플래그를 <strong>기본값으로</strong> 달아 놨고, <strong>(2)</strong> 전역 정책 cvar이 그걸 일괄적으로 켜고 끈다.
</p>

<h3 style="font-size:16px;font-weight:700;color:var(--text);margin-top:32px;">전역 스위치: r.RDG.AsyncCompute</h3>

<div class="code-block"><span class="code-lang">RenderGraphPrivate.cpp</span><span class="ty">TAutoConsoleVariable</span>&lt;<span class="kw">int32</span>&gt; CVarRDGAsyncCompute(
    <span class="str">"r.RDG.AsyncCompute"</span>,
    RDG_ASYNC_COMPUTE_ENABLED, <span class="cm">// 기본 1</span>
    <span class="str">"Controls the async compute policy.\\n"</span>
    <span class="str">" 0:disabled, no async compute is used;\\n"</span>
    <span class="str">" 1:enabled for passes tagged for async compute (default);\\n"</span>
    <span class="str">" 2:enabled for all compute passes implemented to use the compute command list;\\n"</span>);</div>

<div class="ac-table-wrap">
<table class="ac-table">
<thead>
<tr><th>값</th><th>정책</th><th>의미</th></tr>
</thead>
<tbody>
<tr><td><code>0</code></td><td>비활성</td><td>전부 graphics 파이프에서. async 안 씀</td></tr>
<tr><td><code>1</code> (기본)</td><td>태그된 패스만</td><td><code>ERDGPassFlags::AsyncCompute</code>를 단 패스만 async로</td></tr>
<tr><td><code>2</code></td><td>모든 compute 패스</td><td>compute 커맨드 리스트를 쓰는 패스를 <strong>전부 강제로</strong> async로</td></tr>
</tbody>
</table>
</div>

<p class="body">
값이 <code>2</code>일 때 동작이 흥미롭다. RDG는 <code>OverridePassFlags()</code>에서 그냥 compute 패스의 <code>Compute</code> 비트를 떼고 <code>AsyncCompute</code> 비트를 붙여 버린다 — <strong>패스 코드를 한 줄도 안 고치고</strong> 전부 async로 돌린다. "거의 모든 패스가 async"의 극단적 버전이 이 모드다.
</p>

<div class="code-block"><span class="code-lang">RenderGraphBuilder.cpp — OverridePassFlags</span><span class="kw">if</span> (EnumHasAnyFlags(PassFlags, ERDGPassFlags::Compute)
    &amp;&amp; GRDGAsyncCompute == RDG_ASYNC_COMPUTE_FORCE_ENABLED) <span class="cm">// == 2</span>
{
    PassFlags &amp;= ~ERDGPassFlags::Compute;
    PassFlags |= ERDGPassFlags::AsyncCompute;  <span class="cm">// 강제 승격</span>
}</div>

<h3 style="font-size:16px;font-weight:700;color:var(--text);margin-top:32px;">기본값으로 async를 켜 둔 서브시스템들</h3>

<p class="body">
기본 정책(<code>1</code>)에서도 async로 도는 패스가 많은 건, 각 서브시스템이 자기 cvar로 async를 <strong>기본 on</strong> 해 놨기 때문이다. 패턴은 거의 같다 — <code>GSupportsEfficientAsyncCompute</code>(하드웨어가 효율적 async를 지원하나) <strong>그리고</strong> 자기 cvar이 켜져 있으면 <code>ERDGPassFlags::AsyncCompute</code>, 아니면 <code>ERDGPassFlags::Compute</code>를 고른다.
</p>

<div class="code-block"><span class="code-lang">PostProcessFFTBloom.cpp — 전형적 분기</span>Intermediates.ComputePassFlags =
    (GSupportsEfficientAsyncCompute
     &amp;&amp; CVarAsynComputeFFTBloom.GetValueOnRenderThread() != <span class="num">0</span>)
        ? ERDGPassFlags::AsyncCompute
        : ERDGPassFlags::Compute;</div>

<div class="ac-table-wrap">
<table class="ac-table">
<thead>
<tr><th>서브시스템</th><th>cvar</th><th>기본값</th></tr>
</thead>
<tbody>
<tr><td>Lumen (마스터)</td><td><code>r.Lumen.AsyncCompute</code></td><td><strong>1</strong></td></tr>
<tr><td>Lumen Diffuse Indirect</td><td><code>r.Lumen.DiffuseIndirect.AsyncCompute</code></td><td>1</td></tr>
<tr><td>Lumen Reflections</td><td><code>r.Lumen.Reflections.AsyncCompute</code></td><td>0</td></tr>
<tr><td>Lumen Scene Lighting</td><td><code>r.LumenScene.Lighting.AsyncCompute</code></td><td>1</td></tr>
<tr><td>Nanite 래스터화</td><td><code>r.Nanite.AsyncRasterization</code></td><td><strong>1</strong></td></tr>
<tr><td>Nanite 그림자 depth</td><td><code>r.Nanite.AsyncRasterization.ShadowDepths</code></td><td>0</td></tr>
<tr><td>TSR (업스케일)</td><td><code>r.TSR.AsyncCompute</code></td><td><strong>2</strong></td></tr>
<tr><td>FFT Bloom</td><td><code>r.Bloom.AsyncCompute</code></td><td>1</td></tr>
<tr><td>톤매핑 LUT</td><td><code>r.LUT.AsyncCompute</code></td><td>1</td></tr>
<tr><td>SSAO (compute 모드일 때)</td><td><code>r.AmbientOcclusion.Compute</code> = 2/3</td><td>0</td></tr>
<tr><td>Light Grid 컬링</td><td><code>r.Forward.LightGridAsyncCompute</code></td><td>0</td></tr>
<tr><td>Local Fog 타일 컬링</td><td><code>r.LocalFogVolume.TileCullingUseAsync</code></td><td>1</td></tr>
<tr><td>Distance Field 그림자</td><td><code>r.DFShadowAsyncCompute</code></td><td>0</td></tr>
<tr><td>Volumetric 클라우드 RT</td><td><code>r.VolumetricRenderTarget.PreferAsyncCompute</code></td><td>0</td></tr>
<tr><td>Substrate 분류</td><td><code>r.Substrate.AsyncClassification</code></td><td>1</td></tr>
<tr><td>Sky Atmosphere LUT</td><td><code>r.SkyAtmosphereAsyncCompute</code></td><td>0</td></tr>
<tr><td>Stochastic Lighting</td><td><code>r.StochasticLighting.AsyncCompute</code></td><td>1</td></tr>
</tbody>
</table>
</div>

<div class="callout callout-info">
<div class="callout-title">기본 on이 1이 아닌 것도 많다는 점에 주목</div>
<p>Lumen Reflections·Nanite ShadowDepths·DF 그림자·Sky Atmosphere 등은 기본값이 <strong>0</strong>이다. "거의 다 async"처럼 보여도 <strong>전부는 아니다.</strong> 어떤 패스를 async로 돌릴지는 엔진 팀이 플랫폼·콘텐츠별로 측정해 보수적으로 정한 결과다. 무턱대고 켜면 5장에서 볼 경합 때문에 오히려 느려질 수 있기 때문이다.</p>
</div>

<h3 style="font-size:16px;font-weight:700;color:var(--text);margin-top:32px;">async가 실제로 켜지는 전제 조건</h3>

<p class="body">
cvar이 1이어도 항상 async가 도는 건 아니다. RDG는 다음을 모두 만족해야 async를 허용한다. (<code>IsAsyncComputeSupported</code>)
</p>

<div class="code-block"><span class="code-lang">RenderGraphPrivate.h — IsAsyncComputeSupported</span><span class="kw">return</span> GRDGAsyncCompute &gt; <span class="num">0</span>            <span class="cm">// 정책이 켜져 있고</span>
    &amp;&amp; !<span class="fn">IsImmediateMode</span>()              <span class="cm">// 즉시 모드가 아니고</span>
    &amp;&amp; !<span class="fn">IsRenderPassMergeEnabled</span>(SP) <span class="cm">// 렌더패스 머지와는 상호배타</span>
    &amp;&amp; GSupportsEfficientAsyncCompute  <span class="cm">// 하드웨어/RHI가 지원하고</span>
    &amp;&amp; GRHISupportsSeparateDepthStencilCopyAccess;</div>

<p class="body">
특히 <strong>렌더패스 머지와 async는 동시에 못 켠다.</strong> 둘 다 패스 스케줄링을 서로 의존적으로 건드리기 때문이다. 또 <code>GSupportsEfficientAsyncCompute</code>는 RHI(D3D12/Vulkan)가 하드웨어 능력을 보고 세팅하는 전역값이라, <strong>같은 엔진이라도 GPU/드라이버에 따라 async가 통째로 꺼질 수 있다.</strong>
</p>

<span class="section-eyebrow">06 — 자동이 효율적인가</span>

</div>

# RDG 자동화가 손튜닝보다 효율적인가

<div class="ac-post">
<p class="body">
"자동으로 하면 효율이 더 좋은가?"에 대한 정직한 답: <strong>속도의 천장 자체를 높여 주진 않는다.</strong> fork/join을 완벽히 손튜닝한 UE4 코드와 RDG가 만든 펜스 배치는 <em>이론적으로</em> 같은 overlap을 낼 수 있다. RDG의 이점은 "더 빠른 펜스"가 아니라 <strong>"넓게, 정확하게, 공짜로"</strong>에 있다.
</p>

<div class="card-grid">
<div class="card teal">
<div class="card-label">정확함</div>
<div class="card-title">레이스가 원천 차단</div>
<div class="card-desc">fork/join이 그래프의 생산자/소비자에서 기계적으로 나오니, 사람이 펜스를 빠뜨리는 버그가 없다. 의존이 바뀌면 다음 프레임에 다시 계산된다.</div>
</div>
<div class="card blue">
<div class="card-label">최적 배치</div>
<div class="card-title">가장 늦은 fork·가장 이른 join</div>
<div class="card-desc">max/min으로 <strong>겹치는 구간을 최대화</strong>한다. 손으로 하면 "안전하게" 너무 일찍 join을 잡기 쉬운데, RDG는 가장 공격적이면서 안전한 지점을 고른다.</div>
</div>
<div class="card gold">
<div class="card-label">메모리 재활용</div>
<div class="card-title">transient aliasing</div>
<div class="card-desc"><code>r.RDG.AsyncComputeTransientAliasing</code>(기본 1) — fork/join 펜스가 동시 접근을 막아 주니, async 리소스를 graphics 리소스와 <strong>같은 힙에 겹쳐</strong> 메모리를 아낀다.</div>
</div>
<div class="card purple">
<div class="card-label">규모</div>
<div class="card-title">전 패스에 부담 없이 적용</div>
<div class="card-desc">손튜닝은 패스 하나하나가 비용이라 국소적이었다. RDG는 플래그 한 줄이라 <strong>수십 개 서브시스템</strong>이 일제히 async를 쓸 수 있다.</div>
</div>
</div>

<div class="callout callout-warn">
<div class="callout-title">budget — 어느 큐에 얼마나 줄지도 손잡이가 있다</div>
<p>async를 켜는 것과 별개로, "compute 큐에 GPU를 얼마나 떼 줄까"를 <code>EAsyncComputeBudget</code>(<code>ELeast_0</code> … <code>EBalanced_2</code> … <code>EAll_4</code>)으로 조절한다. 예: <code>r.AmbientOcclusion.AsyncComputeBudget</code>. async가 graphics를 너무 굶기면 budget을 낮춰 균형을 잡는, 플랫폼별 저수준 튜닝 손잡이다.</p>
</div>

<p class="body">
요약하면 — <strong>RDG 자동화는 "더 빠르게"가 아니라 "안전하게 더 넓게" 적용하는 도구다.</strong> 그리고 넓게 적용했을 때 실제로 얼마나 빨라지느냐는, 이제 펜스가 아니라 <strong>하드웨어 자원 경합</strong>이 결정한다. 그게 마지막 장이다.
</p>

<span class="section-eyebrow">07 — 왜 켜도 1~2ms뿐인가</span>

</div>

# 왜 async를 켜도 GPU 시간이 1~2ms뿐인가

<div class="ac-post">
<p class="body">
가장 중요한 질문이다. 큐 두 개를 동시에 돌리는데 왜 GPU가 2배가 안 되고, 보통 프레임 전체에서 1~2ms만 줄어들까? 답은 하나로 모인다 — <strong>두 큐는 명령 입구만 다를 뿐, 같은 물리 GPU(같은 CU/SM, 같은 레지스터 파일, 같은 캐시, 같은 메모리 버스)를 나눠 쓴다.</strong> overlap은 "남는 자원"이 있을 때만 생기고, 남는 자원에는 천장이 있다.
</p>

<h3 style="font-size:16px;font-weight:700;color:var(--text);margin-top:32px;">① 실측: 겹치면 둘 다 느려진다</h3>

<p class="body">
한 실측 사례(GTAO를 레이트레이싱 그림자와 겹친 경우)가 이 현상을 잘 보여준다.
</p>

<div class="ac-table-wrap">
<table class="ac-table">
<thead>
<tr><th>구성</th><th>합산 GPU 시간</th><th>관찰</th></tr>
</thead>
<tbody>
<tr><td>직렬 (GTAO → RT 그림자)</td><td>5.73 ms</td><td>기준</td></tr>
<tr><td>async (GTAO ∥ RT 그림자)</td><td><strong>4.6 ms</strong></td><td>1ms 남짓 절약</td></tr>
<tr><td>GTAO 단독</td><td>1.97 ms</td><td>—</td></tr>
<tr><td>GTAO (그림자와 겹치는 중)</td><td><strong>3.22 ms</strong></td><td>같은 GTAO가 1.25ms 더 걸림 — 경합!</td></tr>
</tbody>
</table>
</div>

<p class="body">
포인트는 두 가지다. <strong>(1)</strong> 전체는 분명 빨라졌다(5.73→4.6). <strong>(2)</strong> 그런데 GTAO 자체는 단독 1.97ms에서 겹칠 때 3.22ms로 <strong>느려졌다.</strong> 그림자가 GPU 자원을 가져가니 GTAO 몫이 줄어든 것이다. 흥미롭게도 GTAO를 그냥 compute 파이프에 올리는 것만으로는(겹치지 않으면) 시간 변화가 없었다 — <strong>느려짐은 큐 메커니즘 탓이 아니라 순수하게 자원 경합 탓</strong>임을 보여준다. async의 이득 = (직렬 합) − (겹친 더 긴 쪽) 이고, 경합이 클수록 이 이득이 깎인다.
</p>

<h3 style="font-size:16px;font-weight:700;color:var(--text);margin-top:32px;">② 경합이 일어나는 네 자리</h3>

<div class="step-block s1">
<h4>레지스터·LDS (CU를 나눠 쓸 자리 자체가 없음)</h4>
<p>2장의 복선이 여기서 회수된다. graphics wave가 빈 슬롯을 4개 남겨도, async compute wave가 VGPR/LDS를 많이 쓰면 그 4개를 다 못 채운다. AMD의 표현: <strong>"같은 CU를 공유하는 스레드는 GPR과 LDS를 공유하므로, 가용 자원을 다 쓰는 작업은 async 작업이 같은 CU에서 돌지 못하게 막는다."</strong> 동시 실행의 천장은 결국 레지스터 파일이 정한다.</p>
</div>

<div class="step-block s2">
<h4>캐시 thrashing</h4>
<p>두 큐는 같은 L1/L2를 공유한다. 둘이 서로 다른 데이터를 들이부으면 상대의 캐시 라인을 밀어내(thrash) 둘 다 캐시 미스가 늘어난다. NVIDIA가 "L1/L2·VRAM throughput이 높은 작업끼리는 겹치지 말라"고 권하는 이유다.</p>
</div>

<div class="step-block s3">
<h4>메모리 대역폭</h4>
<p>둘 다 VRAM 대역폭을 쓰면, 대역폭은 고정이라 서로의 몫을 갉아먹는다. depth/지오메트리 패스(대역폭·고정함수 bound) 옆에 ALU 무거운 compute를 두면 잘 겹치는 건, 한쪽은 대역폭을 쓰고 한쪽은 ALU를 써서 <strong>다른 자원</strong>을 쓰기 때문이다.</p>
</div>

<div class="step-block s4">
<h4>fence stall과 WFI</h4>
<p>fork/join 펜스에서 한 큐가 다른 큐를 기다리며 멈춘다. 커맨드 리스트가 너무 잘게 쪼개지면 이 대기 비용이 overlap 이득을 잡아먹는다. NVIDIA의 "wait-for-idle(WFI)"은 더 심해서, 같은 큐의 모든 warp를 강제로 비워 버린다. 그래서 read/write가 겹치는 리소스를 두 큐가 같이 만지면 안 된다.</p>
</div>

<div class="callout callout-coral">
<div class="callout-title">100%를 "쌓을" 수는 없다</div>
<p>NVIDIA가 못박는 핵심: <strong>"여러 작업의 유닛 throughput을 합쳐 100%를 넘기려는 시도는 통하지 않으며, 오히려 전체 성능을 떨어뜨린다."</strong> async는 <em>비어 있는</em> throughput을 줍는 것이지, 없는 throughput을 만드는 게 아니다. 그래서 이미 GPU를 꽉 채운(occupancy 높은) 패스 위에는 async를 끼워도 이득이 없다.</p>
</div>

<h3 style="font-size:16px;font-weight:700;color:var(--text);margin-top:32px;">③ 좋은 짝 vs 나쁜 짝 (실측)</h3>

<div class="ac-table-wrap">
<table class="ac-table">
<thead>
<tr><th>짝</th><th>성격</th><th>결과</th></tr>
</thead>
<tbody>
<tr><td>GTAO + 레이트레이싱 그림자</td><td>캐시/ALU bound + RT-core bound (서로 다름)</td><td>좋음 — 5.73→4.6ms</td></tr>
<tr><td>GTAO + BRDF LUT dispatch</td><td>병목 다름</td><td>좋음 — 7→5.7ms, BRDF가 거의 공짜</td></tr>
<tr><td>GTAO + RTGI 광선 생성</td><td><strong>둘 다</strong> SM·캐시 throughput 높음</td><td>나쁨 — 6.8→6.1ms (거의 안 줄어듦)</td></tr>
</tbody>
</table>
</div>

<p class="body">
규칙은 명확하다 — <strong>병목이 상보적인(complementary) 패스끼리 겹쳐라.</strong> 한쪽이 지오메트리/고정함수에 묶여 ALU가 비는 동안 ALU 무거운 compute를 태우면 이득이 크고, 둘 다 같은 자원(SM·캐시·대역폭)을 쥐어짜면 거의 이득이 없다. 프레임 앞부분(shadow·z-prepass·g-buffer)이 보통 지오메트리 bound라 "남는 ALU를 줍기" 가장 좋은 구간이라는 점도 같은 이야기다.
</p>

<div class="callout callout-info">
<div class="callout-title">미래의 함정 — RDNA4 동적 VGPR</div>
<p>RDNA4는 thread가 실행 중 VGPR을 동적으로 늘리는 모드를 도입했다. 그런데 이 모드로 뜬 workgroup은 <strong>GPU 코어 하나를 통째로 "점유"</strong>하기 때문에, 동적/비동적 스레드가 같은 코어에 공존할 수 없다. 즉 동적 VGPR로 뜬 compute는 graphics와 같은 코어에서 못 겹친다. 하드웨어가 발전해도 "동시 실행의 천장은 레지스터가 정한다"는 명제는 형태만 바꿔 계속 따라온다.</p>
</div>

<span class="section-eyebrow">08 — 정리</span>

</div>

# 정리: async compute를 다룰 때의 사고법

<div class="ac-post">

<div class="step-block s4">
<h4>1. async = 별도 큐로 노는 실행 유닛을 줍는 것</h4>
<p>graphics가 ALU를 못 채우는 구간(특히 depth·shadow 같은 지오메트리 bound 패스)에 compute를 겹쳐 GPU를 더 채운다. 이득의 본질은 "빈 자원 줍기"다.</p>
</div>

<div class="step-block s3">
<h4>2. 빈 자원의 천장은 occupancy = VGPR/SGPR/LDS가 정한다</h4>
<p>occupancy가 100%가 아니어서 슬롯이 비고, async가 그 슬롯을 채운다. 하지만 async wave도 레지스터를 쓰므로, 둘 다 무거우면 같은 CU에 못 올라간다.</p>
</div>

<div class="step-block s2">
<h4>3. UE5에서는 RDG가 fork/join을 자동으로 한다</h4>
<p><code>ERDGPassFlags::AsyncCompute</code> 한 줄 → RDG가 cross-pipeline 생산자/소비자에서 <strong>가장 늦은 fork·가장 이른 join</strong>을 계산해 펜스를 삽입. UE4의 수동 <code>FComputeFenceRHIRef</code> 작업이 통째로 사라졌다. <code>r.RDG.AsyncCompute</code> 0/1/2로 전역 정책을, 서브시스템 cvar로 패스별 on/off를 제어한다.</p>
</div>

<div class="step-block s1">
<h4>4. 켠다고 공짜가 아니다 — 병목이 상보적일 때만 이득</h4>
<p>같은 캐시·대역폭·레지스터를 두 큐가 나눠 쓰므로 경합이 생긴다. 그래서 보통 프레임당 1~2ms. 프로파일링(GPU Trace / RGP / Unreal Insights의 RenderGraph track)으로 <strong>실제로 겹쳤는지, 겹쳐서 둘 다 느려지진 않았는지</strong>를 반드시 측정해야 한다.</p>
</div>

<div class="callout callout-teal">
<div class="callout-title">실전 한 줄</div>
<p>async on/off로 1~2ms 차이가 난다면 그건 <strong>버그가 아니라 정상</strong>이다. GPU가 이미 잘 채워져 있을수록 async가 주울 빈 자원이 적기 때문이다. 더 짜내고 싶다면 "async를 더 켜라"가 아니라 <strong>"병목이 다른 패스끼리 겹치게 스케줄을 짜라"</strong>가 맞는 방향이다.</p>
</div>

<p class="body" style="margin-top:28px;">
한 줄로 닫으면 — RDG는 UE4에서 사람이 위험하게 손으로 걸던 fork/join 펜스를, <strong>그래프에 이미 적힌 의존성에서 기계적으로 뽑아내</strong> 모든 패스에 안전하게 적용할 수 있게 했다. 덕분에 async가 "기본값"이 됐지만, 그게 만든 속도의 천장은 여전히 <strong>하드웨어가 — occupancy와 레지스터 파일과 대역폭이 — 정한다.</strong> 자동화가 바꾼 건 "얼마나 빠른가"가 아니라 "얼마나 쉽고 안전하게 그 천장까지 가는가"다.
</p>

</div>


