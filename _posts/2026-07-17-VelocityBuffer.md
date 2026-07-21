---
layout: post
title: "UE5 RenderVelocities: 모든 temporal 기법이 딛고 선 한 장의 버퍼"
icon: paper
permalink: velocity
categories: Rendering
tags: [Rendering, UnrealEngine, Velocity, MotionVector, TAA, TSR, MotionBlur, Reprojection]
excerpt: "TAA·TSR·모션 블러·레이트레이싱 디노이저는 전부 같은 질문에서 시작한다 — '이 픽셀은 이전 프레임에 어디 있었나?' 그 답을 담는 것이 velocity 버퍼이고, 이 버퍼를 채우는 것이 RenderVelocities 패스다. UE 5.8 소스를 직접 따라가며 velocity가 '두 프레임의 행렬과 두 프레임의 WPO로 정점을 두 번 변환한 차이'라는 것, CPU의 FSceneVelocityData와 GPUScene이 이전 프레임 트랜스폼을 어떻게 이어주는지, 움직인 것만 골라 그리는 3단 게이팅과 기본 머티리얼 스왑, r.VelocityOutputPass 세 모드와 depth pass를 둘로 쪼개는 DDM_AllOpaqueNoVelocity 트릭, float depth를 16비트 둘로 쪼개고 최하위 비트에 플래그를 숨기는 인코딩, 그리고 안 그린 픽셀을 ClipToPrevClip으로 복원하는 소비자 규약까지 코드로 확인한다."
img_name: "velocity-buffer-core-sketch.webp"
back_color: "#ffffff"
toc: false
show: true
new: true
series: -1
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - TAA/TSR/모션 블러 글마다 등장하는 "velocity 버퍼"가 정확히 무엇이고 어떻게 만들어지는지 궁금한 분
> - 모션 벡터가 "카메라 모션 + 오브젝트 모션 + 정점 애니메이션"을 어떻게 한 번에 담는지 수식으로 보고 싶은 분
> - 정지한 배경 픽셀은 velocity를 안 그리는데 왜 리프로젝션이 되는지 의아했던 분
> - r.VelocityOutputPass 0/1/2가 프레임 타임라인에서 뭘 바꾸는지, depth pass가 왜 둘로 쪼개지는지 알고 싶은 분
> - 움직이는 오브젝트가 TAA에서 고스팅을 남길 때 어디부터 의심해야 하는지 디버깅 순서가 필요한 분
>
> **이 글로 알 수 있는 내용**
>
> - velocity = 현재 NDC − 이전 NDC — 정점을 <em>두 프레임의 행렬로 두 번</em> 변환하는 <code>VelocityShader.usf</code>의 실제 수식
> - 이전 프레임 WPO(World Position Offset)까지 다시 계산해서 머티리얼 정점 애니메이션도 velocity에 담는다는 것
> - CPU <code>FSceneVelocityData</code>가 트랜스폼을 한 프레임 시프트하는 방식과 10프레임 트리밍 규칙
> - "움직인 것만 그린다"의 실제 구현 — <code>DrawsVelocity</code> / 0.0001f 행렬 비교 / 화면 반경 컷의 3단 게이팅
> - <code>r.VelocityOutputPass</code> 세 모드: depth pass 분할(<code>DDM_AllOpaqueNoVelocity</code>), base pass GBuffer MRT, 별도 패스
> - G16R16 vs RGBA16 포맷 분기(Lumen/레이트레이싱이 depth 성분을 요구하는 이유)와 ±2 NDC 감마 인코딩, 최하위 비트에 숨은 픽셀 애니메이션 플래그
> - 안 그린 픽셀은 <code>EncodedVelocity.x > 0</code> 규약과 <code>ClipToPrevClip</code>로 복원된다는 것
> - 반투명 velocity가 translucency <em>이후</em>에 depth까지 쓰는 이유와 64비트 아토믹으로 비트만 마킹하는 clipped depth 패스
> - TSR/TAA/모션블러/Lumen 디노이저가 이 버퍼를 각자 어떻게 소비하는지

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
.vel-post {
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
.vel-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.vel-post .card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin: 24px 0;
}
.vel-post .card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.vel-post .card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
}
.vel-post .card.blue::before   { background: var(--accent); }
.vel-post .card.gold::before   { background: var(--gold); }
.vel-post .card.teal::before   { background: var(--teal); }
.vel-post .card.coral::before  { background: var(--coral); }
.vel-post .card.purple::before { background: var(--accent2); }
.vel-post .card.orange::before { background: var(--orange); }
.vel-post .card-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.vel-post .card.blue   .card-label { color: var(--accent); }
.vel-post .card.gold   .card-label { color: var(--gold); }
.vel-post .card.teal   .card-label { color: var(--teal); }
.vel-post .card.coral  .card-label { color: var(--coral); }
.vel-post .card.purple .card-label { color: var(--accent2); }
.vel-post .card.orange .card-label { color: var(--orange); }
.vel-post .card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}
.vel-post .card-desc {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.65;
  margin: 0;
}
.vel-post .callout {
  border-radius: 12px;
  padding: 18px 20px;
  margin: 24px 0;
  border: 1px solid var(--border);
  background: var(--surface);
}
.vel-post .callout-title {
  font-weight: 700;
  font-size: 14px;
  margin-bottom: 8px;
  color: var(--text);
}
.vel-post .callout p { font-size: 14px; color: var(--text2); line-height: 1.8; margin: 0; }
.vel-post .callout-info    { border-left: 3px solid var(--accent); }
.vel-post .callout-purple  { border-left: 3px solid var(--accent2); }
.vel-post .callout-warn    { border-left: 3px solid var(--coral); }
.vel-post .callout-gold    { border-left: 3px solid var(--gold); }
.vel-post .callout-teal    { border-left: 3px solid var(--teal); }
.vel-post .data-table { overflow-x: auto; margin: 24px 0; }
.vel-post .data-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13.5px;
  background: var(--surface);
  border-radius: 12px;
  overflow: hidden;
}
.vel-post .data-table th {
  background: var(--surface2);
  color: var(--text);
  font-weight: 700;
  text-align: left;
  padding: 10px 14px;
  border-bottom: 2px solid var(--border2);
  white-space: nowrap;
}
.vel-post .data-table td {
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text2);
  line-height: 1.6;
}
.vel-post .flow-row {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 8px;
  margin: 24px 0;
}
.vel-post .flow-step {
  flex: 1 1 130px;
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 12px 14px;
  min-width: 130px;
}
.vel-post .flow-step.dim { opacity: 0.55; border-style: dashed; }
.vel-post .flow-step.hot { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.vel-post .step-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 4px;
}
.vel-post .step-name { font-size: 13.5px; font-weight: 700; color: var(--text); margin-bottom: 4px; }
.vel-post .step-desc { font-size: 12.5px; color: var(--text2); line-height: 1.6; }
.vel-post .flow-arrow {
  align-self: center;
  color: var(--text3);
  font-weight: 700;
}
.vel-post .code-block {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 18px;
  margin: 20px 0;
  color: var(--text);
  overflow-x: auto;
  white-space: pre;
  line-height: 1.9;
}
.vel-post .code-lang {
  font-size: 11px;
  font-weight: 600;
  color: var(--text3);
  margin-bottom: 8px;
  letter-spacing: 0.04em;
}
.vel-post .code-block .kw  { color: var(--accent2); }
.vel-post .code-block .fn  { color: var(--accent); }
.vel-post .code-block .num { color: var(--gold); }
.vel-post .code-block .cm  { color: var(--text3); }
.vel-post .code-block .str { color: var(--teal); }
.vel-post .bit-row {
  display: flex;
  gap: 4px;
  margin: 20px 0;
  font-family: 'JetBrains Mono', monospace;
  flex-wrap: wrap;
}
.vel-post .bit-cell {
  flex: 1 1 90px;
  text-align: center;
  border-radius: 8px;
  padding: 10px 6px;
  font-size: 12px;
  line-height: 1.5;
  border: 1px solid var(--border2);
  background: var(--surface);
  color: var(--text2);
}
.vel-post .bit-cell b { display:block; font-size: 12.5px; color: var(--text); }
.vel-post .bit-cell.blue   { border-color: var(--accent);  background: rgba(61,99,224,0.07); }
.vel-post .bit-cell.gold   { border-color: var(--gold);    background: rgba(176,125,0,0.07); }
.vel-post .bit-cell.coral  { border-color: var(--coral);   background: rgba(214,48,49,0.07); }
.vel-post .bit-cell.purple { border-color: var(--accent2); background: rgba(114,72,212,0.07); }
</style>

<div class="vel-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# 개요: "이 픽셀은 이전 프레임에 어디 있었나"

<div class="vel-post">
<p style="color:var(--text2);line-height:1.85;">
현대 실시간 렌더링의 품질은 상당 부분 <strong>시간축 재사용</strong>에서 나온다. TAA와 TSR은 지난 프레임들의 샘플을 누적해 슈퍼샘플링을 흉내 내고, 모션 블러는 픽셀이 한 프레임 동안 움직인 궤적을 따라 색을 번지게 하고, Lumen과 레이트레이싱 디노이저는 픽셀당 광선 몇 개짜리 노이즈를 히스토리로 눌러 편다. 방법은 제각각이지만 이들이 던지는 첫 질문은 정확히 같다 — <strong>"지금 이 픽셀에 보이는 표면은, 이전 프레임에는 화면 어디에 있었나?"</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
그 답을 픽셀마다 담아둔 것이 <strong>velocity 버퍼</strong>(모션 벡터 버퍼)다. 각 픽셀에 "이전 프레임 위치까지의 스크린 공간 변위"를 저장하고, 소비자는 <code>현재 UV − velocity</code>로 히스토리 텍스처를 샘플링한다. 그리고 이 버퍼를 채우는 렌더러 패스가 이 글의 주인공 <strong><code>RenderVelocities</code></strong>다. UE 5.8 기준 구현의 중심은 <code>Engine\Source\Runtime\Renderer\Private\VelocityRendering.cpp</code>(1,442줄)와 셰이더 <code>VelocityShader.usf</code>이고, 프레임 어디에서 실행할지는 <code>DeferredShadingRenderer.cpp</code>가 결정한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
velocity 버퍼가 "그냥 화면 차분 아닌가" 싶지만, 실제 구현은 생각보다 설계 결정이 많다. <strong>모든 픽셀을 그리지 않고</strong> 움직인 것만 골라 그리는 컬링, 이전 프레임의 트랜스폼·본 포지션·머티리얼 WPO를 <strong>한 프레임 어긋나게 보관하는</strong> 데이터 파이프라인, depth pass·base pass·별도 패스 중 <strong>언제 그릴지</strong>의 트레이드오프, 16비트 네 채널에 모션·깊이·플래그를 욱여넣는 인코딩까지. 이 글은 그 결정들을 소스 순서가 아니라 데이터가 흐르는 순서로 따라간다.
</p>

<div class="card-grid">
<div class="card blue"><div class="card-label">WHAT</div><div class="card-title">픽셀별 모션 벡터</div><p class="card-desc">현재 NDC − 이전 NDC. xy는 화면 변위, (필요하면) z는 device depth 변화량까지.</p></div>
<div class="card purple"><div class="card-label">WHO</div><div class="card-title">움직인 것만</div><p class="card-desc">movable + 실제로 움직였고 + 화면에서 충분히 큰 프리미티브만 드로우. 나머지는 소비자가 복원.</p></div>
<div class="card gold"><div class="card-label">WHEN</div><div class="card-title">r.VelocityOutputPass</div><p class="card-desc">0=depth pass에서, 1=base pass GBuffer로, 2=base pass 후 별도 패스. 기본은 0.</p></div>
<div class="card teal"><div class="card-label">WHY</div><div class="card-title">temporal 공용 인프라</div><p class="card-desc">TAA·TSR·모션블러·디노이저·SSR이 전부 이 한 장 위에서 리프로젝션한다.</p></div>
</div>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
<p>UE 5.8 소스(<code>Renderer/Private/VelocityRendering.cpp/.h</code>, <code>DeferredShadingRenderer.cpp</code>, <code>DepthRendering.cpp</code>, <code>SceneTextures.cpp</code>, <code>ScenePrivate.h</code>, <code>RendererScene.cpp</code>, <code>PrimitiveSceneProxy.h/.cpp</code>, <code>GPUSkinCache.cpp</code>, 셰이더 <code>VelocityShader.usf</code> · <code>VelocityCommon.ush</code> · <code>Common.ush</code> · <code>TSRDilateVelocity.usf</code> · <code>TemporalAA.usf</code> · <code>MotionBlurVelocityFlatten.usf</code> · <code>LumenPosition.ush</code>)를 직접 읽고 정리했다. 인용한 줄 번호는 UE 5.8 기준이며 버전에 따라 이동할 수 있다. 같은 블로그의 <a href="/taa">TAA</a>·<a href="/tsr">TSR</a> 글이 이 버퍼의 "소비자" 시점이라면, 이 글은 "공급자" 시점이다.</p>
</div>

<span class="section-eyebrow">01 — 수식</span>
</div>

# 정점을 두 번 변환한다 — 현재의 행렬로 한 번, 이전 프레임의 행렬로 한 번

<div class="vel-post">
<p style="color:var(--text2);line-height:1.85;">
velocity의 본질은 한 문장이다. <strong>같은 정점을 현재 프레임의 변환으로 한 번, 이전 프레임의 변환으로 한 번, 총 두 번 클립 공간에 투영하고 그 차이를 기록한다.</strong> "이전 프레임의 변환"에는 이전 프레임의 오브젝트 트랜스폼(LocalToWorld)과 이전 프레임의 카메라 행렬(ViewProjection)이 모두 들어가므로, 오브젝트가 움직였든 카메라가 움직였든 둘 다 자연스럽게 벡터에 포함된다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<code>VelocityShader.usf</code>의 버텍스 셰이더가 정확히 이 구조다. 눈여겨볼 것은 <strong>WPO(World Position Offset)를 두 번 평가한다는 점</strong>이다 — 현재 위치에는 현재의 WPO를, 이전 위치에는 <code>GetMaterialPreviousWorldPositionOffset</code>으로 <em>이전 프레임 시간 기준의</em> WPO를 더한다. 머티리얼이 시간 기반 정점 애니메이션(바람에 흔들리는 풀 등)을 하고 있다면 그 움직임까지 velocity에 잡히는 이유다.
</p>

<div class="code-block"><div class="code-lang">HLSL — VelocityShader.usf : 62-88 (MainVertexShader 요지)</div><span class="cm">// 현재 프레임: 월드 위치 + 현재 WPO</span>
<span class="kw">float4</span> TranslatedWorldPosition = <span class="fn">VertexFactoryGetWorldPosition</span>(Input, VFIntermediates);
TranslatedWorldPosition.xyz += <span class="fn">GetMaterialWorldPositionOffset</span>(VertexParameters);

<span class="cm">// 이전 프레임: 이전 트랜스폼으로 변환한 월드 위치 + "이전 프레임의" WPO</span>
<span class="kw">float4</span> PrevTranslatedWorldPosition = <span class="fn">VertexFactoryGetPreviousWorldPosition</span>(Input, VFIntermediates);
PrevTranslatedWorldPosition.xyz += <span class="fn">GetMaterialPreviousWorldPositionOffset</span>(VertexParameters);

<span class="cm">// 클립 공간 투영 — 이전 위치는 "이전 프레임 카메라 행렬"로</span>
<span class="kw">float4</span> PrevScreenPos = <span class="fn">mul</span>(<span class="kw">float4</span>(PrevTranslatedWorldPosition.xyz, <span class="num">1</span>), ResolvedView.<span class="fn">PrevTranslatedWorldToClip</span>);
<span class="kw">float4</span> ScreenPos     = <span class="fn">mul</span>(<span class="kw">float4</span>(TranslatedWorldPosition.xyz, <span class="num">1</span>),     ResolvedView.<span class="fn">TranslatedWorldToClip</span>);
Output.Position = ScreenPos;   <span class="cm">// 래스터라이즈는 현재 위치로, 두 클립 좌표는 인터폴런트로 PS에 전달</span></div>

<p style="color:var(--text2);line-height:1.85;">
픽셀 셰이더는 이 두 클립 좌표를 받아 perspective divide를 하고 차이를 구한다. 이때 한 가지 정리를 더 한다 — <strong>TAA 지터 제거</strong>다. 현재 프레임과 이전 프레임은 각각 다른 서브픽셀 지터로 렌더링되었으므로, 그대로 빼면 지터 차이가 가짜 모션으로 섞인다. 그래서 현재 좌표에서는 현재 지터를, 이전 좌표에서는 이전 지터를 빼서 "지터 없는 세계"의 순수한 모션만 남긴다.
</p>

<div class="code-block"><div class="code-lang">HLSL — VelocityCommon.ush : 9-40 (Calculate3DVelocity)</div><span class="kw">float2</span> ScreenPos     = PackedVelocityA.xy / PackedVelocityA.w - JitterA;  <span class="cm">// 현재 지터 (TemporalAAJitter.xy)</span>
<span class="kw">float2</span> PrevScreenPos = PackedVelocityC.xy / PackedVelocityC.w - JitterC;  <span class="cm">// 이전 지터 (TemporalAAJitter.zw)</span>

<span class="kw">float</span> DeviceZ     = PackedVelocityA.z / PackedVelocityA.w;
<span class="kw">float</span> PrevDeviceZ = PackedVelocityC.z / PackedVelocityC.w;

<span class="cm">// 3D velocity: xy = 스크린 변위, z = device depth 변화량</span>
<span class="kw">float3</span> Velocity = <span class="kw">float3</span>(ScreenPos - PrevScreenPos, DeviceZ - PrevDeviceZ);</div>

<div class="callout callout-purple">
<div class="callout-title">velocity는 2D가 아니라 3D일 수 있다</div>
<p>xy만 있으면 "화면에서 어디로 움직였나"는 알지만 "카메라에서 멀어졌나 가까워졌나"는 모른다. z(device depth 변화량)까지 있으면 소비자가 <strong>이전 프레임의 depth를 복원</strong>할 수 있고, 이것이 Lumen·레이트레이싱의 히스토리 depth 검증에 필요하다(→ 06·09장). 그래서 velocity 버퍼 포맷 자체가 플랫폼의 Lumen/RT 지원 여부에 따라 2채널/4채널로 갈린다.</p>
</div>

<span class="section-eyebrow">02 — 이전 프레임 데이터</span>
</div>

# "이전 프레임"은 공짜가 아니다 — 트랜스폼·본·WPO의 한 프레임 시프트

<div class="vel-post">
<p style="color:var(--text2);line-height:1.85;">
셰이더가 <code>VertexFactoryGetPreviousWorldPosition</code>을 호출할 수 있으려면, 누군가 이전 프레임의 트랜스폼을 <strong>버리지 않고 한 프레임 더 들고 있어야</strong> 한다. UE는 이걸 세 층으로 관리한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>① CPU — <code>FSceneVelocityData</code></strong> (<code>ScenePrivate.h:1275-1400</code>). 씬은 movable 프리미티브마다 <code>{ LocalToWorld, PreviousLocalToWorld, LastFrameUsed, LastFrameUpdated }</code>를 맵으로 보관한다. 매 프레임 시작(<code>StartFrame</code>, <code>RendererScene.cpp:3320-3348</code>)에 <code>Previous = Current</code>로 시프트하므로 항상 <strong>직전 1프레임</strong>만 유지된다. 재미있는 디테일 둘 — 오브젝트가 움직인 <em>다음</em> 프레임에는 Current는 안 변해도 Previous가 변하므로 GPUScene을 강제로 dirty 처리한다(<code>MarkGPUStateDirty(ChangedTransform)</code>). 그리고 10프레임 넘게 조회되지 않은 항목은 100프레임마다 도는 트리밍에서 제거된다. 텔레포트처럼 "이번 프레임만 이전 위치를 속이고 싶은" 경우를 위한 <code>OverridePreviousTransform</code>도 여기 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>② GPU — GPUScene의 <code>PreviousLocalToWorld</code></strong>. CPU가 갱신한 이전 트랜스폼은 GPUScene 프리미티브/인스턴스 데이터에 실려 올라가고(<code>SceneData.ush:79,155</code>), 버텍스 팩토리가 이를 읽어 이전 월드 위치를 만든다(<code>LocalVertexFactory.ush:1262-1278</code>). 즉 velocity 패스는 별도의 트랜스폼 버퍼를 갖지 않는다 — GPU-driven 파이프라인의 씬 데이터에 이전 프레임 열이 하나 더 있는 것뿐이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>③ 스켈레탈 메시 — GPU Skin Cache의 이전 포지션 버퍼</strong>. 본 애니메이션은 트랜스폼 하나로 표현이 안 되므로, 스킨 캐시가 <strong>이전 프레임 본 행렬로 스키닝한 정점 위치 버퍼를 따로</strong> 만들어둔다(<code>GPUSkinCache.cpp:1643-1668</code>). 벨로시티 VS는 패스스루 버텍스 팩토리를 통해 이 <code>PreviousPosition</code> SRV를 읽는다(<code>:656-663</code>). 이것이 per-bone motion blur의 실체이고, 그래서 <code>bPerBoneMotionBlur</code>가 켜진 스켈레탈 메시 프록시는 <code>bAlwaysHasVelocity = true</code>로 매 프레임 velocity 패스에 들어간다(<code>SkeletalMeshSceneProxy.cpp:175-178</code>).
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">CPU</div><div class="step-name">FSceneVelocityData</div><div class="step-desc">프리미티브별 Previous LocalToWorld를 한 프레임 시프트로 유지</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">UPLOAD</div><div class="step-name">GPUScene</div><div class="step-desc">PreviousLocalToWorld가 인스턴스 데이터로 상주</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">VF</div><div class="step-name">VertexFactory</div><div class="step-desc">GetPreviousWorldPosition + 이전 WPO / 스킨캐시 prev position</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step hot"><div class="step-num">SHADER</div><div class="step-name">VelocityShader</div><div class="step-desc">두 번 투영 → NDC 차이 = velocity</div></div>
</div>

<span class="section-eyebrow">03 — 누가 그리나</span>
</div>

# 전부 그리지 않는다 — 3단 게이팅과 기본 머티리얼 스왑

<div class="vel-post">
<p style="color:var(--text2);line-height:1.85;">
화면의 대부분은 정지한 배경이다. 정지한 픽셀의 모션은 카메라 행렬만으로 계산할 수 있으므로(→ 07장), velocity 패스는 <strong>그 계산으로 답이 안 나오는 것들만</strong> 그리면 된다. UE는 이를 <code>FOpaqueVelocityMeshProcessor</code>의 3단 검사로 거른다.
</p>

<div class="data-table">
<table>
<tr><th>단계</th><th>함수 (VelocityRendering.cpp)</th><th>거르는 것</th></tr>
<tr><td>① 자격</td><td><code>PrimitiveCanHaveVelocity</code> (:878-897)</td><td><code>DrawsVelocity()</code> — movable이거나, <code>bAlwaysHasVelocity</code>(스켈레탈·파티클·인스턴스 동적 데이터), WPO velocity, 픽셀 애니메이션 머티리얼 등. 아니면 아예 캐시드 드로우 커맨드도 안 만든다.</td></tr>
<tr><td>② 이번 프레임</td><td><code>PrimitiveHasVelocityForFrame</code> (:899-918)</td><td><code>AlwaysHasVelocity</code>가 아니면 <code>LocalToWorld.Equals(Previous, 0.0001f)</code> — <strong>실제로 안 움직인 프레임엔 그리지 않는다</strong>. movable이어도 가만히 있으면 배경 취급.</td></tr>
<tr><td>③ 이번 뷰</td><td><code>PrimitiveHasVelocityForView</code> (:840-876)</td><td>화면 반경이 <code>MotionBlurPerObjectSize × 0.5 / 100 × LODDistanceFactor</code>보다 작으면 스킵 — 멀리 있는 작은 오브젝트의 per-object 모션은 비용 대비 티가 안 난다. 카메라 컷 프레임도 스킵.</td></tr>
</table>
</div>

<div class="code-block"><div class="code-lang">C++ — VelocityRendering.cpp : 899-918 (움직였는지의 실제 판정)</div><span class="kw">if</span> (!PrimitiveSceneProxy-&gt;<span class="fn">AlwaysHasVelocity</span>())
{
    FMatrix PreviousLocalToWorld = LocalToWorld;
    Scene-&gt;VelocityData.<span class="fn">GetComponentPreviousLocalToWorld</span>(PrimitiveComponentId, PreviousLocalToWorld);

    <span class="kw">if</span> (LocalToWorld.<span class="fn">Equals</span>(PreviousLocalToWorld, <span class="num">0.0001f</span>))
    {
        <span class="kw">return false</span>;   <span class="cm">// 안 움직였음 — 배경처럼 취급 (velocity 미기록)</span>
    }
}</div>

<p style="color:var(--text2);line-height:1.85;">
통과한 메시에도 최적화가 하나 더 있다. velocity 패스는 색을 계산하지 않으므로, 머티리얼이 픽셀을 버리지 않고(<code>WritesEveryPixel</code>) 양면도 아니고 정점도 안 건드리면 그 머티리얼의 셰이더를 쓸 이유가 없다 — <strong>엔진 기본 머티리얼로 스왑</strong>해버린다(<code>UseDefaultMaterial</code>, <code>:920-926</code>). 수백 개 머티리얼이 velocity 패스에서는 단 하나의 셰이더·PSO를 공유하게 되는 것이다. 반대로 masked, two-sided, WPO, 모션벡터 오프셋 머티리얼은 자기 셰이더로 그려야 하므로, 셰이더 퍼뮤테이션도 정확히 그 조건일 때만 컴파일된다(<code>TVelocityVS::ShouldCompilePermutation</code>, <code>:151-203</code>).
</p>

<div class="callout callout-gold">
<div class="callout-title">WPO 머티리얼은 "움직인 적 없어도" 그려야 한다</div>
<p>바람에 흔들리는 풀은 액터 트랜스폼이 영원히 그대로다 — ② 검사로는 절대 안 걸린다. 그래서 <code>r.Velocity.EnableVertexDeformation</code>(기본 2=Auto)이 켜져 있으면 WPO 머티리얼을 쓰는 프리미티브는 <code>bHasWorldPositionOffsetVelocity</code>로 <code>AlwaysHasVelocity</code> 대열에 합류한다(<code>PrimitiveSceneProxy.cpp:621-625</code>). Auto의 의미는 "<code>r.VelocityOutputPass=2</code>(별도 패스)가 아닐 때만 On" — 별도 패스 모드에서는 이 물량이 순수 추가 드로우 비용이라 기본으로 꺼진다. 흔들리는 풀이 TAA에서 지글거린다면 십중팔구 이 설정이 원인이다.</p>
</div>

<span class="section-eyebrow">04 — 언제 그리나</span>
</div>

# r.VelocityOutputPass — 같은 데이터, 세 가지 타이밍

<div class="vel-post">
<p style="color:var(--text2);line-height:1.85;">
velocity를 <em>언제</em> 그릴지는 read-only CVar <code>r.VelocityOutputPass</code>가 정한다(<code>VelocityRendering.cpp:30-37</code>). 값에 따라 프레임 타임라인이 실제로 달라진다.
</p>

<div class="flow-row">
<div class="flow-step hot"><div class="step-num">모드 0 (기본)</div><div class="step-name">Depth pass에서</div><div class="step-desc">depth prepass를 "velocity 없는 것"과 "있는 것" 둘로 쪼갠다. velocity 대상은 prepass에서 빠지고, 직후 velocity 패스가 depth+velocity를 동시에 쓴다.</div></div>
<div class="flow-step"><div class="step-num">모드 1</div><div class="step-name">Base pass GBuffer로</div><div class="step-desc">GBuffer MRT에 velocity 타깃을 하나 추가. 별도 패스 없음 — 지오메트리를 한 번만 돌리는 대신 base pass 대역폭 증가.</div></div>
<div class="flow-step"><div class="step-num">모드 2</div><div class="step-name">Base pass 이후 별도로</div><div class="step-desc">고전적인 방식. base pass가 끝난 뒤 움직인 메시만 다시 드로우(depth는 읽기 전용, DepthNearOrEqual 테스트).</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>모드 0의 트릭이 가장 흥미롭다.</strong> 이때 EarlyZPassMode는 <code>DDM_AllOpaqueNoVelocity</code>가 되는데(<code>RendererScene.cpp:4446-4468</code>), 이름 그대로 depth prepass가 "velocity를 낼 오브젝트만 빼고" 전부를 그린다. depth 패스의 메시 프로세서가 velocity 3단 게이팅과 <strong>정확히 같은 검사</strong>를 돌려서 통과할 놈들을 <code>bDraw = false</code>로 스킵하고(<code>DepthRendering.cpp:1064-1089</code>), 바로 이어지는 <code>RenderVelocities(EVelocityPass::Opaque)</code>가 그 나머지의 depth와 velocity를 <strong>한 번의 드로우로</strong> 채운다. 이때만 velocity 패스의 depth 접근이 읽기 전용이 아니라 <code>DepthWrite</code>로 승격된다(<code>VelocityRendering.cpp:512-515</code>).
</p>

<div class="code-block"><div class="code-lang">C++ — DeferredShadingRenderer.cpp : 2470-2474 (모드 0: prepass 직후 velocity)</div><span class="cm">// special pass for DDM_AllOpaqueNoVelocity, which uses the velocity pass</span>
<span class="cm">// to finish the early depth pass write</span>
<span class="kw">if</span> (bShouldRenderVelocities &amp;&amp; Scene-&gt;EarlyZPassMode == DDM_AllOpaqueNoVelocity)
{
    <span class="fn">RenderVelocities</span>(GraphBuilder, InViews, LocalSceneTextures,
                     EVelocityPass::Opaque, bForceVelocityOutput, ...);
}</div>

<p style="color:var(--text2);line-height:1.85;">
움직이는 오브젝트는 어차피 depth를 써야 하니, 그 드로우에 컬러 타깃 하나만 얹으면 velocity가 <em>거의 공짜</em>라는 발상이다. 대가도 있다 — depth pass에 묶였으므로 "이번 프레임에 velocity가 필요한가"를 뷰 상태로 따질 수 없어, 모드 0에서는 <code>ShouldRenderVelocities()</code>가 <strong>무조건 true</strong>를 반환한다(<code>VelocityRendering.cpp:355-362</code> 주석이 이 트레이드오프를 그대로 적고 있다). 모드 1은 반대 극단으로, 드로우는 아예 공짜지만 base pass MRT가 한 장 늘어 타일 메모리/대역폭이 비싼 플랫폼에 불리하고, 그래서 모바일과 데스크톱 포워드(MSAA 가능성)에서는 강제로 비활성이다(<code>IsUsingBasePassVelocity</code>, <code>RenderUtils.cpp:1699-1712</code>).
</p>

<div class="callout callout-teal">
<div class="callout-title">Nanite는 애초에 별도 패스가 없다</div>
<p>Nanite 지오메트리는 velocity 메시 패스를 돌지 않는다. 래스터 결과에서 depth를 내보내는 <code>Nanite::EmitDepthTargets</code>가 <code>VELOCITY_EXPORT</code> 퍼뮤테이션으로 <strong>depth와 velocity를 동시에 export</strong>한다(<code>NaniteComposition.cpp:256-410</code>). GPU에 이미 인스턴스별 이전 트랜스폼이 있으니 visible cluster에서 바로 계산하는 것이다. 단 모드 1일 때는 base pass GBuffer가 담당하므로 velocity 버퍼를 넘기지 않는다(<code>DeferredShadingRenderer.cpp:1790-1802</code>). 스킨드 나나이트는 <code>FSkinningDim</code> 퍼뮤테이션이 함께 붙는다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
패스 본체(<code>FSceneRenderer::RenderVelocities</code>, <code>VelocityRendering.cpp:482-715</code>)는 전형적인 메시 패스 실행부다. 몇 가지만 짚으면 — <code>r.ParallelVelocity=1</code>(기본)이면 병렬 커맨드리스트로 디스패치하고(<code>:614-624</code>), velocity 타깃 클리어는 가능하면 별도 클리어 패스 대신 <strong>RT LoadAction=EClear에 얹어서</strong> 공짜로 처리하며(<code>:549-608</code>), 드로우할 게 하나도 없는 뷰는 (hair strands나 distortion이 강제하지 않는 한) 바인딩조차 하지 않고 스킵한다. "빈 velocity 패스"는 실제로 아무 GPU 비용도 내지 않는다.
</p>

<span class="section-eyebrow">05 — 포맷과 인코딩</span>
</div>

# 16비트 네 채널에 모션·깊이·플래그를 욱여넣기

<div class="vel-post">
<p style="color:var(--text2);line-height:1.85;">
velocity 텍스처(<code>SceneVelocity</code>)는 <code>SceneTextures.cpp:727</code>에서 만들어지고, 포맷은 플랫폼에 따라 갈린다(<code>FVelocityRendering::GetFormat</code>, <code>VelocityRendering.cpp:786-800</code>).
</p>

<div class="data-table">
<table>
<tr><th>조건</th><th>포맷</th><th>채널 구성</th></tr>
<tr><td>기본</td><td><code>PF_G16R16</code> (32bpp)</td><td>RG = 인코딩된 모션 xy</td></tr>
<tr><td><code>NeedVelocityDepth</code> — Lumen GI 지원(+Distance Fields) 또는 레이트레이싱 지원 플랫폼</td><td><code>PF_A16B16G16R16</code> (64bpp)</td><td>RG = 모션 xy, <strong>BA = device-Z 변화량(float32를 16비트 둘로 분할)</strong></td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
인코딩(<code>EncodeVelocityToTexture</code>, <code>Common.ush:2064-2089</code>)은 세 가지 장치의 조합이다. 첫째, xy에 <strong>부호 보존 제곱근 감마</strong>를 걸어 작은 모션에 정밀도를 몰아준다 — 1픽셀 미만의 미세한 모션이 벌벌 떨리면 temporal 기법이 바로 티가 나기 때문이다. 둘째, 스케일을 <code>0.499 × 0.5</code>로 잡아 <strong>±2 NDC 범위</strong>(화면 두 장 거리의 고속 모션)까지 표현하되, 풀레인지를 살짝 남겨 <strong>클리어 값 (0,0)이 어떤 유효 인코딩과도 겹치지 않게</strong> 한다. 셋째, z는 float32 비트를 그대로 <code>asuint</code>해서 상위 16비트를 B채널에, 하위 16비트를 A채널에 나눠 싣는다.
</p>

<div class="code-block"><div class="code-lang">HLSL — Common.ush : 2064-2089 (EncodeVelocityToTexture 요지)</div><span class="cm">// 1) 감마 인코딩: 작은 모션에 정밀도 집중 (SM5+)</span>
V.xy = <span class="fn">sign</span>(V.xy) * <span class="fn">sqrt</span>(<span class="fn">abs</span>(V.xy)) * (<span class="num">2.0</span> / <span class="fn">sqrt</span>(<span class="num">2.0</span>));

<span class="cm">// 2) ±2 범위를 0..1로. 0.499 → (0,0)을 "velocity 없음" 특수값으로 예약</span>
EncodedV.xy = V.xy * (<span class="num">0.499f</span> * <span class="num">0.5f</span>) + <span class="num">32767.0f</span> / <span class="num">65535.0f</span>;

<span class="cm">// 3) depth 변화량: float32 비트를 16비트 둘로 분할</span>
<span class="kw">uint</span> Vz = <span class="fn">asuint</span>(V.z);
EncodedV.z = ...(Vz &gt;&gt; <span class="num">16</span>) &amp; <span class="num">0xFFFF</span>...;                       <span class="cm">// 상위 16비트</span>
EncodedV.w = ...((Vz &amp; VELOCITY_Z_LOW_MASK) | <span class="fn">FlagBits</span>)...;   <span class="cm">// 하위 16비트 + 플래그</span></div>

<p style="color:var(--text2);line-height:1.85;">
마지막 줄이 이 인코딩의 백미다. depth 하위 16비트의 <strong>최하위 1~2비트를 버리고 그 자리에 플래그를 숨긴다</strong>(<code>Common.ush:2047-2059</code>). bit0은 <code>HasPixelAnimation</code> — 머티리얼이 픽셀 단위 애니메이션(패닝 텍스처 등)을 한다는 표식으로, TSR이 이 픽셀의 히스토리를 다르게 다루는 근거가 된다. bit1은 <code>TemporalResponsiveness</code>. 디코딩 쪽은 <code>VELOCITY_Z_LOW_MASK</code>(0xFFFC)로 마스킹해 depth를 복원하니, 실질 손실은 device-Z 변화량의 최하위 2비트뿐이다.
</p>

<div class="bit-row">
<div class="bit-cell blue"><b>R (16bit)</b>모션 x<br>감마 + ±2 스케일</div>
<div class="bit-cell blue"><b>G (16bit)</b>모션 y<br>감마 + ±2 스케일</div>
<div class="bit-cell gold"><b>B (16bit)</b>ΔdeviceZ<br>float32 상위 16비트</div>
<div class="bit-cell gold"><b>A (14bit)</b>ΔdeviceZ<br>하위 비트</div>
<div class="bit-cell coral"><b>A bit1</b>Temporal<br>Responsiveness</div>
<div class="bit-cell coral"><b>A bit0</b>HasPixel<br>Animation</div>
</div>

<span class="section-eyebrow">06 — 정지 픽셀</span>
</div>

# 안 그린 픽셀은 어떻게 되나 — x > 0 규약과 ClipToPrevClip

<div class="vel-post">
<p style="color:var(--text2);line-height:1.85;">
3장의 게이팅 때문에 velocity 텍스처의 대부분은 클리어 값 (0,0) 그대로다. 그런데 카메라가 도는 동안에는 정지한 벽도 화면에서는 움직인다 — 이 모션은 누가 계산하나? 답: <strong>소비자가 각자, depth로부터</strong>. 정지한 표면의 이전 프레임 위치는 오브젝트 정보가 필요 없다. 현재 픽셀의 (ScreenPos, DeviceZ)를 <code>View.ClipToPrevClip</code>(현재 클립 → 이전 프레임 클립 행렬) 하나로 되돌리면 끝이다.
</p>

<div class="code-block"><div class="code-lang">HLSL — MotionBlurVelocityFlatten.usf : 136-142 (소비자 공통 패턴)</div><span class="cm">// 기본값: depth + ClipToPrevClip 로 계산한 카메라 모션</span>
<span class="kw">float2</span> Velocity = <span class="fn">GetCameraMotionVelocity</span>(DispatchThreadId, DeviceZ, View.ClipToPrevClip);

<span class="cm">// velocity가 "그려진" 픽셀만 덮어씀 — x &gt; 0 이 유효 마커</span>
<span class="kw">if</span> (EncodedVelocity.x &gt; <span class="num">0.0</span>)
{
    Velocity = <span class="fn">DecodeVelocityFromTexture</span>(EncodedVelocity).xy;
}</div>

<p style="color:var(--text2);line-height:1.85;">
이 <code>EncodedVelocity.x &gt; 0.0</code> 한 줄이 velocity 시스템 전체를 관통하는 규약이다. 05장의 인코딩이 유효한 xy를 절대 0에 매핑하지 않도록 0.499로 범위를 좁힌 이유가 정확히 여기 있다 — <strong>"0 = 안 그려짐 = 정적 표면, 카메라 모션으로 복원하라"</strong>. TAA(<code>TemporalAA.usf:2113-2132</code>), TSR(<code>TSRDepthVelocityAnalysis.ush:118-142</code>의 <code>ComputeStaticVelocity</code>), 모션 블러, Lumen이 전부 같은 분기를 갖고 있다. 덕분에 velocity 패스는 화면의 5%만 그리고도 100%의 모션 필드를 제공한다.
</p>

<div class="callout callout-warn">
<div class="callout-title">이 규약의 함정 — "그려졌어야 하는데 안 그려진" 픽셀</div>
<p>이 설계에서 버그는 항상 같은 모양으로 나타난다. 움직이는 오브젝트가 어떤 이유로든 velocity 패스에서 빠지면(EnableVertexDeformation 꺼짐, 화면 반경 컷, 커스텀 프록시가 <code>DrawsVelocity</code> 미구현 등) 소비자는 그 픽셀을 <strong>정지 표면으로 오인</strong>하고 카메라 모션으로 리프로젝션한다 → 히스토리가 엉뚱한 곳에서 오고 → TAA 고스팅/스미어링. 반대 방향의 도구가 <code>r.Velocity.ForceOutput=1</code>(전부 그리기)로, 비용은 들지만 "게이팅 문제인지"를 즉시 판별해준다. <code>Show → Visualize → Motion Blur</code>나 <code>VisualizeTemporalUpscaler</code>로 velocity를 눈으로 확인하는 것이 디버깅의 시작점이다.</p>
</div>

<span class="section-eyebrow">07 — 반투명</span>
</div>

# 반투명 velocity — 순서의 문제, 그리고 비트만 마킹하는 패스

<div class="vel-post">
<p style="color:var(--text2);line-height:1.85;">
반투명은 velocity가 곤란한 물건이다. depth를 쓰지 않으니 "이 픽셀의 표면"이 하나로 정해지지 않고, 그렇다고 무시하면 움직이는 반투명(캐릭터 위 이펙트, 유리창)이 히스토리를 오염시킨다. UE의 답은 <strong>별도의 늦은 패스</strong>다. <code>EVelocityPass::Translucent</code>는 translucency 컬러 합성이 <em>모두 끝난 뒤</em> 실행되어 velocity와 함께 <strong>depth까지 쓴다</strong>(<code>VelocityRendering.h:25-26</code>). 이미 색은 다 섞였으니 이제 depth를 써도 컬러에 영향이 없고, 뒤이은 DoF·모션 블러·TSR은 반투명 표면의 depth/velocity를 갖게 된다. 대상은 머티리얼에서 명시적으로 "Output Velocity"를 켠 것만이고, 이 패스는 depth를 쓰는 특성상 <strong>움직임 여부로 컬링하지 않는다</strong>(<code>:1068-1081</code> — 안 그리면 DoF가 깨진다는 주석이 달려 있다).
</p>

<p style="color:var(--text2);line-height:1.85;">
5.8에는 여기에 두 개의 변형이 더 있다. <strong>early velocity 패스</strong>(<code>r.Translucency.EarlyVelocityPass</code>, 기본 2)는 async compute가 가능한 플랫폼에서 이 패스를 프레임 앞쪽으로 당긴다 — 원본 depth를 건드리면 안 되므로 depth를 별도 텍스처로 복사한 뒤 그 위에 그리고, 프레임 끝에서 <code>SceneTextures.Depth.Resolve</code>를 교체한다(<code>DeferredShadingRenderer.cpp:3618-3653</code>). 그리고 <strong><code>TranslucentClippedDepth</code></strong> 패스는 더 특이하다 — opacity mask에 <em>잘려서 안 그려진</em> 반투명 픽셀에, 색도 depth도 아닌 <strong>temporal responsiveness 비트 하나만</strong> 남긴다. 렌더 타깃 블렌딩으로는 특정 비트만 OR할 수 없으므로 <strong>64비트 이미지 아토믹</strong>으로 velocity 텍스처의 A채널 최하위 비트를 직접 지진다(<code>VelocityShader.usf:238-244</code> — <code>ImageInterlockedOrUInt64</code> 후 <code>clip(-1)</code>로 컬러 출력은 버린다). 그래서 이 기능은 Nanite급 64비트 아토믹 지원을 요구한다(<code>SupportsTranslucentClippedDepth</code>).
</p>

<span class="section-eyebrow">08 — 소비자들</span>
</div>

# 한 장의 버퍼, 다섯 갈래의 소비

<div class="vel-post">
<p style="color:var(--text2);line-height:1.85;">
이제 완성된 버퍼가 어디로 가는지 보자. <code>ShouldRenderVelocities()</code>(<code>VelocityRendering.cpp:349-391</code>)에 나열된 소비자 목록이 곧 지도다 — TAA/temporal 계열, 모션 블러, Distance Field AO, SSR temporal, 레이트레이싱 디노이저, SSGI, Lumen, distortion. 소비 방식은 크게 다섯 갈래다.
</p>

<div class="card-grid">
<div class="card blue"><div class="card-label">TSR</div><div class="card-title">dilate + 분석 패스</div><p class="card-desc">3×3에서 가장 가까운 depth의 velocity를 골라(dilation) 리프로젝션 필드를 만들고, 이웃 velocity 차분으로 jacobian까지 추정. <code>Velocity.z</code>로 이전 depth를 복원해 disocclusion 판정에 쓴다 (TSRDilateVelocity.usf).</p></div>
<div class="card purple"><div class="card-label">TAA</div><div class="card-title">2px X-패턴 dilation</div><p class="card-desc">AA_CROSS로 주변 4점 중 가장 가까운 depth의 위치에서 velocity를 읽는다 — 실루엣 1~2px 바깥까지 전경의 모션을 확장해 가장자리 고스팅을 막는 고전 기법 (TemporalAA.usf:2062-2132).</p></div>
<div class="card gold"><div class="card-label">Motion Blur</div><div class="card-title">flatten + 타일 min/max</div><p class="card-desc">velocity를 타일별 극좌표 min/max로 리듀스해 "이 타일은 블러 없음/단순/복잡"을 분류하고 fast path를 태운다. 옵션으로 카메라 모션 성분만 제거해 오브젝트 블러만 남기기도 (MotionBlurVelocityFlatten.usf).</p></div>
<div class="card teal"><div class="card-label">Lumen / RT</div><div class="card-title">히스토리 depth 검증</div><p class="card-desc">GetHistoryScreenPosition이 velocity로 이전 UV와 <strong>이전 device-Z</strong>를 함께 산출, <code>abs(HistoryDeviceZ − PrevDeviceZ)</code> 비교로 히스토리 유효성을 검증한다 (LumenPosition.ush:41-85). velocity에 z가 들어간 이유가 이것.</p></div>
<div class="card coral"><div class="card-label">SSR</div><div class="card-title">이전 프레임 컬러 재사용</div><p class="card-desc">반사 히트 지점을 velocity로 이전 프레임에 리프로젝션해 이전 씬 컬러를 재사용 (SSRTPrevFrameReduction.usf). 움직이는 오브젝트의 반사가 흐르지 않게 하는 장치.</p></div>
<div class="card orange"><div class="card-label">공통 규약</div><div class="card-title">x&gt;0 / ClipToPrevClip</div><p class="card-desc">다섯 갈래 모두 동일한 분기 — 그려진 픽셀은 디코딩, 아니면 depth+카메라 행렬로 복원. 06장의 규약이 전 소비자에 복제되어 있다.</p></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
정리하면 velocity 버퍼의 포맷 분기(05장)까지 소비자가 설명한다. 2채널이면 충분한 것은 TAA·모션 블러처럼 <strong>화면 변위만</strong> 필요한 소비자들이고, Lumen·레이트레이싱처럼 <strong>이전 프레임 depth까지 검증하는</strong> 소비자가 있는 플랫폼에서만 4채널을 쓴다. 버퍼 하나의 픽셀 포맷이 렌더러 기능 매트릭스의 함수인 셈이다.
</p>

<span class="section-eyebrow">09 — 튜닝과 디버깅</span>
</div>

# CVar 지도와 고스팅 디버깅 순서

<div class="vel-post">

<div class="data-table">
<table>
<tr><th>CVar</th><th>기본</th><th>언제 만지나</th></tr>
<tr><td><code>r.VelocityOutputPass</code></td><td>0</td><td>0=depth pass(기본, velocity 거의 공짜) / 1=base pass MRT(드로우 절약, 대역폭 증가) / 2=별도 패스. <strong>ReadOnly + 전체 셰이더 리컴파일</strong>이라 프로젝트 초기에 결정할 것.</td></tr>
<tr><td><code>r.ParallelVelocity</code></td><td>1</td><td>병렬 커맨드리스트 기록. 끌 이유는 거의 없다.</td></tr>
<tr><td><code>r.Velocity.EnableVertexDeformation</code></td><td>2 (Auto)</td><td>WPO 머티리얼(풀·나무·깃발)의 velocity. Auto는 모드 2에서 꺼진다 — 식생이 TAA에서 지글거리면 1로 고정해볼 것.</td></tr>
<tr><td><code>r.Velocity.ForceOutput</code></td><td>0</td><td>전 프리미티브 강제 velocity. 게이팅 문제 디버깅용 스위치로 최고, 상시 켜기엔 비용이 있다(모드 1에서는 저렴).</td></tr>
<tr><td><code>r.Translucency.Velocity</code> / <code>EarlyVelocityPass</code></td><td>1 / 2</td><td>반투명 velocity와 early 패스 위치. async compute 활용도가 낮은 플랫폼이면 early를 0으로.</td></tr>
<tr><td>(PP 세팅) <code>MotionBlurPerObjectSize</code></td><td>-</td><td>per-object velocity의 최소 화면 크기(%). 낮추면 작은 오브젝트까지 velocity를 그린다 — 프로젝타일이 블러/AA에서 이상하면 여기.</td></tr>
<tr><td>폐기: <code>r.BasePassOutputsVelocity</code>, <code>r.VertexDeformationOutputsVelocity</code></td><td>-</td><td>5.8에서 설정 시 경고 로그. 각각 <code>r.VelocityOutputPass</code>, <code>r.Velocity.EnableVertexDeformation</code>으로 이전.</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
움직이는 무언가가 고스팅/스미어링을 남길 때의 점검 순서를 코드 근거와 함께 적어두면 이렇다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">1</div><div class="step-name">눈으로 확인</div><div class="step-desc">VisualizeMotionBlur / VisualizeTemporalUpscaler로 해당 픽셀에 velocity가 실제로 찍히는지 본다.</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">2</div><div class="step-name">강제 출력 테스트</div><div class="step-desc">r.Velocity.ForceOutput=1로 사라지면 게이팅 문제 — WPO 설정, 화면 반경 컷, DrawsVelocity 순으로 의심.</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">3</div><div class="step-name">데이터 문제</div><div class="step-desc">안 사라지면 "이전 위치"가 틀린 것 — 텔레포트에 OverridePreviousTransform 누락, 커스텀 VF의 PreviousWorldPosition 미구현, 스킨캐시 비활성 등.</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">4</div><div class="step-name">소비자 문제</div><div class="step-desc">velocity는 맞는데 남는다면 TAA/TSR의 히스토리 rejection 영역 — 이 블로그의 TAA·TSR 글 참조.</div></div>
</div>

<span class="section-eyebrow">정리</span>
</div>

# 정리

<div class="vel-post">
<p style="color:var(--text2);line-height:1.85;">
<code>RenderVelocities</code>는 화려한 패스가 아니다. 하지만 이 글에서 본 것처럼, 그 밑에는 일관된 설계가 깔려 있다 — <strong>① 같은 정점을 두 프레임의 변환(행렬·WPO·본)으로 두 번 투영해 차이를 기록하고, ② 그 "이전 프레임 변환"을 CPU(FSceneVelocityData)와 GPU(GPUScene·스킨캐시)가 한 프레임 시프트로 이어주며, ③ 답이 depth만으로 복원 가능한 정지 픽셀은 아예 그리지 않고(0.499 인코딩과 x&gt;0 규약), ④ 그려야 하는 것들은 depth pass에 얹어 거의 공짜로 처리한다(DDM_AllOpaqueNoVelocity).</strong> 여기에 Lumen/RT를 위한 depth 성분과 숨은 플래그 비트, 반투명을 위한 늦은 패스와 아토믹 마킹 패스가 곁가지로 붙는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
temporal 기법의 품질 문제는 대부분 "히스토리를 언제 믿을 것인가"의 문제이고, 그 판단의 입력이 전부 이 버퍼다. TAA의 고스팅도, TSR의 disocclusion 처리도, 모션 블러의 방향도, Lumen의 히스토리 검증도 velocity가 틀리면 함께 틀린다. 소비자 쪽 파라미터를 만지기 전에 공급자 쪽 — 이 글의 게이팅과 데이터 파이프라인 — 을 먼저 의심하는 것이 결과적으로 빠른 길인 경우가 많다.
</p>

<span class="section-eyebrow">참고</span>
</div>

# 참고

<div class="vel-post">
<p style="color:var(--text2);line-height:1.85;">
<strong>소스 (UE 5.8)</strong><br>
- <code>Engine/Source/Runtime/Renderer/Private/VelocityRendering.cpp / .h</code> — 패스 본체, 메시 프로세서, 게이팅, CVar<br>
- <code>Engine/Source/Runtime/Renderer/Private/DeferredShadingRenderer.cpp</code> — 호출 지점 6곳(모드 0/2, 반투명 표준/early)<br>
- <code>Engine/Source/Runtime/Renderer/Private/DepthRendering.cpp</code> — DDM_AllOpaqueNoVelocity의 depth pass 분할<br>
- <code>Engine/Source/Runtime/Renderer/Private/ScenePrivate.h</code>, <code>RendererScene.cpp</code> — FSceneVelocityData<br>
- <code>Engine/Source/Runtime/Engine/Public/PrimitiveSceneProxy.h</code>, <code>Private/PrimitiveSceneProxy.cpp</code> — DrawsVelocity/AlwaysHasVelocity, WPO velocity<br>
- <code>Engine/Source/Runtime/Engine/Private/GPUSkinCache.cpp</code> — 이전 포지션 버퍼<br>
- <code>Engine/Shaders/Private/VelocityShader.usf</code>, <code>VelocityCommon.ush</code>, <code>Common.ush</code> — 셰이더와 인코딩<br>
- <code>Engine/Shaders/Private/TemporalSuperResolution/TSRDilateVelocity.usf</code>, <code>TemporalAA.usf</code>, <code>MotionBlur/MotionBlurVelocityFlatten.usf</code>, <code>Lumen/LumenPosition.ush</code> — 소비자들
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>같이 읽으면 좋은 글</strong><br>
- 이 블로그: <a href="/taa">TAA — 시간에 분할상환하는 슈퍼샘플링</a> (velocity dilation을 소비자 시점에서), <a href="/tsr">TSR — History Rejection</a> (dilate velocity 패스와 reprojection field)<br>
- Epic 공식 문서: Actor의 모션 블러/velocity 관련 설정, <code>r.VelocityOutputPass</code> 레퍼런스
</p>
</div>
