---
layout: post
title: "UE5.8 Ray Traced Shadows: 그림자를 텍스처가 아니라 광선으로 — shadow ray 한 발에서 SSD 디노이저까지"
icon: paper
permalink: raytracing-shadow
categories: Rendering
tags: [ComputerGraphics, Rendering, UnrealEngine, RayTracing, Shadows, DXR, SoftShadow, Denoising, MegaLights]
excerpt: "Ray Traced Shadows는 섀도우 맵이라는 우회로를 버리고, 픽셀에서 광원을 향해 광선을 직접 쏘아 가시성을 묻는 기법이다. 이 글은 UE 5.8 소스를 코드로 끝까지 추적한다 — RenderLights의 광원별 기법 선택(GetLightOcclusionType)과 MegaLights 우선순위, RayTracingOcclusionRGS.usf의 광원 타입별 콘/구면 샘플링으로 만드는 소프트 섀도우, RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH라는 섀도우 레이의 정석 최적화, 셀프 인터섹션 회피용 이중 트레이스, 마스크드/반투명 머티리얼의 any-hit 처리, 그리고 페넘브라 노이즈를 지우는 SSD ShadowVisibilityMask 디노이저(라이트 4개 배칭)까지. DXR 사양, Ray Tracing Gems, NRD SIGMA, 하이브리드 기법과 대조해 섀도우 맵 대비 어디서 이기고 어디서 지는지까지 정리한다."
back_color: "#ffffff"
img_name: "raytracing-shadow-core-sketch-white.webp"
toc: false
show: true
new: true
series: -1
index: 21
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - 라이트의 "Cast Ray Traced Shadows"를 켜면 프레임에서 정확히 무슨 일이 벌어지는지 궁금한 분
> - 섀도우 레이가 왜 일반 광선보다 싸게 추적되는지 — `RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH`의 의미가 궁금한 분
> - Source Radius / Source Angle을 키우면 그림자가 부드러워지는 원리를 샘플링 수식 레벨로 알고 싶은 분
> - 1 spp 그림자의 페넘브라 노이즈를 디노이저가 어떻게 지우는지, UE의 SSD와 NVIDIA NRD SIGMA가 어떻게 다른지 궁금한 분
> - 섀도우 맵(VSM)과 레이트레이싱 섀도우 중 뭘 쓸지, 하이브리드는 어떻게 구성하는지 판단 기준이 필요한 분
> - `r.RayTracing.Shadows.*` CVar들이 파이프라인 어디에 꽂히는지 알고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - 섀도우 맵의 고질병(acne, peter panning, 해상도 앨리어싱)이 왜 "광원 시점 렌더링"이라는 구조에서 나오고, shadow ray가 이를 어떻게 원천 회피하는지
> - DXR 섀도우 레이의 정석 — 페이로드를 "가려짐"으로 초기화하고 miss 셰이더만 쓰게 하는 뒤집힌 로직과 3종 RAY_FLAG 조합
> - UE 5.8 `GetLightOcclusionType()`의 4갈래 분기 — Shadowmap / Raytraced / MegaLights / MegaLightsVSM
> - `RenderRayTracingShadows()`가 광원 scissor rect로 트레이스 영역을 자르고 TLAS Base 레이어에 광선을 쏘는 흐름
> - 광원 타입별 소프트 섀도우 샘플링 — directional의 SourceAngle 콘, point/spot의 구면 입체각, rect의 spherical rectangle
> - 셀프 인터섹션(shadow acne의 레이트레이싱 버전)을 막는 normal bias + 짧은 epsilon 트레이스 이중 장치
> - 마스크드 머티리얼의 any-hit 평가, 반투명 그림자의 별도 트레이스, 헤어의 sub-pixel 마스크
> - SSD 섀도우 디노이저의 입력(페넘브라 + closest occluder 거리)과 5단계 패스, 라이트 4개 배칭
> - 섀도우 맵 vs 레이트레이싱 vs 하이브리드(FidelityFX Hybrid Shadows, 페넘브라 분류 기반)의 성능 비교
> - MegaLights가 5.8에서 이 레거시 경로를 어떻게 대체해 가는지

<br>

{% include research-post-style.html %}

<div class="research-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# 개요: 섀도우 맵이라는 우회로, shadow ray라는 직진

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
"이 픽셀에서 광원이 보이는가?" — 그림자의 본질은 이 가시성 질문 하나다. 그런데 래스터라이저는 이 질문에 직접 답할 수 없다. 래스터화는 카메라에서 씬을 향하는 방향으로만 작동하기 때문이다. 그래서 지난 수십 년간 실시간 렌더링은 우회로를 썼다 — <strong>광원 시점에서 씬을 한 번 더 렌더링해 깊이를 저장해두고(섀도우 맵)</strong>, 셰이딩할 때 그 깊이와 비교해 가려짐을 판정하는 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
섀도우 맵의 고질병은 전부 이 우회로를 택한 대가다. 광원 시점의 텍셀과 화면 픽셀이 1:1로 맞지 않아 생기는 <strong>해상도 앨리어싱</strong>과 곡면의 <strong>faceting</strong>, 깊이 비교의 정밀도 문제인 <strong>shadow acne</strong>, acne를 bias로 밀다가 그림자가 발밑에서 떨어져 나가는 <strong>peter panning</strong>. <a href="/virtualshadowmap">Virtual Shadow Map</a>이 해상도 문제를 가상 텍스처링으로 크게 완화했지만, "광원 시점 이미지를 경유한다"는 구조 자체는 그대로다.
</p>

<p style="color:var(--text2);line-height:1.85;">
하드웨어 레이트레이싱(DXR)은 이 질문에 <strong>직진</strong>한다. 셰이딩할 픽셀의 월드 위치에서 광원을 향해 광선(shadow ray)을 쏘고, 중간에 무언가에 맞으면 그림자, 아니면 빛이다. 중간 표현이 없으니 해상도 앨리어싱도, 광원 시점 깊이 비교도 없다 — 픽셀 정확도의 그림자가 기본값이 된다. 게다가 광원을 점이 아닌 <strong>면적(area)</strong>으로 샘플링하면, 접촉점에서는 날카롭고 멀어질수록 부드러워지는 <strong>물리적으로 올바른 페넘브라</strong>가 샘플링만으로 따라 나온다 — 섀도우 맵 필터링(PCF/PCSS)이 근사로만 만들어내던 결과다.
</p>

<p style="color:var(--text2);line-height:1.85;">
물론 공짜는 아니다. 면광원 샘플링은 픽셀당 광선 몇 개로는 <strong>노이즈</strong>가 되고, 이 노이즈를 지우는 <strong>디노이저</strong>가 파이프라인의 필수 구성원이 된다. 그리고 매 프레임 화면 전체에 광선을 쏘는 비용은 광원 수에 비례해 쌓인다. 이 글은 UE 5.8이 이 트레이드오프를 어떻게 구현했는지 — 광원별 기법 선택부터 레이 생성 셰이더, 디노이저, 그리고 섀도우 맵과의 하이브리드 전략까지 — 소스 코드로 추적한다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
<p>1차 출처는 <strong>Unreal Engine 5.8 소스</strong>다 — <code>Renderer/Private/LightRendering.cpp</code>, <code>Renderer/Private/RayTracing/RayTracingShadows.cpp</code>, 셰이더 <code>RayTracingOcclusionRGS.usf</code> · <code>RayTracingDirectionalLight.ush</code> · <code>RayTracingSphereLight.ush</code> · <code>RayTracingRectLight.ush</code>, 디노이저 <code>ScreenSpaceDenoise.cpp</code> + <code>SSD*.usf</code>, 그리고 <code>MegaLights/*</code>. 이론·비교 배경은 <strong>DXR 사양(Microsoft DirectX Raytracing Spec)</strong>, <strong>Ray Tracing Gems 1권 13장 "Ray Traced Shadows" (Boksanský, Wimmer, Bittner 2019)</strong>, <strong>Ray Tracing Gems 2권 24장 (Boksanský 2021)</strong>, <strong>NVIDIA NRD(SIGMA)</strong>, <strong>AMD FidelityFX Hybrid Shadows</strong> 문서에 근거했다. 성능 수치는 각 출처의 측정 하드웨어와 함께 표기한다.</p>
</div>

<span class="section-eyebrow">01 — shadow ray</span>
</div>

# 섀도우 레이는 왜 싼가: 정석 3종 RAY_FLAG와 뒤집힌 페이로드

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
섀도우 레이는 레이트레이싱에서 가장 값싼 광선이다. 이유는 질문이 단순해서다. 반사 광선은 "가장 가까운 히트가 <strong>무엇</strong>인지"를 알아야 그 표면을 셰이딩하지만, 섀도우 레이는 <strong>"뭐라도 맞았는가"</strong>만 알면 된다. 가장 가까운 히트를 찾을 필요도, 히트 지점의 머티리얼을 평가할 필요도 없다. DXR은 이 특성을 활용하는 플래그를 사양 차원에서 마련해 뒀다.
</p>

<div class="data-table">
<table>
<tr><th>RAY_FLAG</th><th>효과</th><th>섀도우 레이에서의 의미</th></tr>
<tr><td><code>ACCEPT_FIRST_HIT_AND_END_SEARCH</code></td><td>아무 히트나 하나 확정되면 순회 즉시 종료</td><td>"가장 가까운" 히트를 찾는 탐색 자체를 생략 — 섀도우 레이 최적화의 핵심</td></tr>
<tr><td><code>SKIP_CLOSEST_HIT_SHADER</code></td><td>히트가 확정돼도 closest-hit 셰이더 미실행</td><td>히트 시 셰이더 코드가 하나도 안 돎 — 가려짐 판정은 miss 셰이더 부재로 충분</td></tr>
<tr><td><code>FORCE_OPAQUE</code></td><td>모든 지오메트리를 불투명 취급, any-hit 미실행</td><td>알파 테스트 평가 생략. 단, 마스크드 머티리얼(나뭇잎 등)의 그림자가 틀려짐</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
여기에 페이로드 로직을 <strong>뒤집는</strong> 기법이 함께 쓰인다. 페이로드를 "가려졌다"로 초기화해 두고, <strong>miss 셰이더만</strong> "가려지지 않았다"를 쓰게 하는 것이다. 그러면 광선이 무언가에 맞은 경우(그림자) 셰이더가 <em>하나도</em> 실행되지 않고, 광원까지 뚫린 경우에만 miss 셰이더가 한 번 돈다. 세 플래그를 다 켠 구성은 벤치마크로도 가장 빠르다 — RTX 2070·Sponza·720p 기준 약 399 MRay/s로, any-hit이나 closest-hit을 남긴 구성보다 순회 비용이 낮게 측정됐다(Will Usher, 2019).
</p>

<div class="code-block"><div class="code-lang">HLSL — DXR 섀도우 레이의 정석 패턴</div><span class="cm">// 페이로드를 "가려짐"으로 초기화 — 히트 시 아무 셰이더도 안 돌게</span>
ShadowPayload payload;  payload.visible = <span class="kw">false</span>;

<span class="fn">TraceRay</span>(TLAS,
         RAY_FLAG_FORCE_OPAQUE |                      <span class="cm">// any-hit 생략</span>
         RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH |   <span class="cm">// 첫 히트에서 종료</span>
         RAY_FLAG_SKIP_CLOSEST_HIT_SHADER,            <span class="cm">// closest-hit 생략</span>
         mask, <span class="num">0</span>, <span class="num">0</span>, <span class="num">0</span>, ray, payload);

<span class="cm">// miss 셰이더: payload.visible = true;  ← 셰이더 실행은 이 한 곳뿐</span>
<span class="kw">float</span> shadow = payload.visible ? <span class="num">1.0</span> : <span class="num">0.0</span>;</div>

<p style="color:var(--text2);line-height:1.85;">
불투명 지오메트리에 any-hit 셰이더가 없으면 DXR 구현은 셰이더 호출 없이 하드웨어 순회만으로 히트를 확정할 수 있다 — 즉 완전 불투명 씬의 섀도우 레이는 <strong>고정 기능 하드웨어만으로</strong> 처리된다. 예외는 알파 테스트다. 나뭇잎·철망 같은 마스크드 머티리얼은 텍스처를 읽어봐야 뚫렸는지 알 수 있으므로 any-hit 셰이더가 필요하고, 이때는 <code>FORCE_OPAQUE</code>를 뺀 채 any-hit이 <code>IgnoreHit()</code>(구멍)이나 <code>AcceptHitAndEndSearch()</code>(막힘)를 호출한다. "속도냐(모든 표면 불투명 취급) 정확한 나뭇잎 그림자냐(any-hit 평가)"는 모든 엔진이 고르는 트레이드오프고, UE가 <code>r.RayTracing.Shadows.EnableMaterials</code>로 노출하는 것이 바로 이 선택이다(→ 05장).
</p>

<div class="callout callout-purple">
<div class="callout-title">DXR 1.1 — inline ray tracing</div>
<p>DXR 1.1의 <code>RayQuery</code>는 raygen/hit/miss 셰이더 테이블 없이 <strong>아무 셰이더 스테이지에서나</strong>(컴퓨트 포함) 광선을 추적하게 해준다. Microsoft는 이 기능의 대표 사용처로 <strong>그림자 계산</strong>을 명시했다 — 히트 시 실행할 셰이딩이 없는 섀도우 레이는 동적 셰이더 스케줄링의 오버헤드를 치를 이유가 없기 때문이다. UE 5.8도 RT 파이프라인 셰이더를 지원하지 않고 inline RT만 지원하는 RHI에서는 같은 셰이더 본문을 컴퓨트 셰이더(<code>FOcclusionCS</code>)로 컴파일해 돌린다(→ 03장).</p>
</div>

<span class="section-eyebrow">02 — 파이프라인 통합</span>
</div>

# 광원 하나마다 갈림길: GetLightOcclusionType의 4갈래

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
UE의 디퍼드 렌더러에서 그림자 기법은 씬 단위가 아니라 <strong>광원 단위</strong>로 선택된다. <code>RenderLights()</code>의 광원 루프(<code>LightRendering.cpp</code>)가 광원마다 <code>GetLightOcclusionType()</code>을 물어 네 갈래로 분기한다.
</p>

<div class="code-block"><div class="code-lang">C++ — LightRendering.cpp (GetLightOcclusionType)</div><span class="ty">ELightOcclusionType</span> <span class="fn">GetLightOcclusionType</span>(<span class="kw">const</span> <span class="ty">FLightSceneProxy</span>&amp; Proxy, <span class="kw">const</span> <span class="ty">FSceneViewFamily</span>&amp; ViewFamily)
{
    <span class="kw">bool</span> bUseRaytracing = <span class="fn">ShouldRenderRayTracingShadowsForLight</span>(ViewFamily, Proxy);
    <span class="ty">EMegaLightsMode</span> MegaLightsMode = MegaLights::<span class="fn">GetMegaLightsMode</span>(ViewFamily, Proxy.<span class="fn">GetLightType</span>(), ...);

    <span class="kw">if</span> (MegaLightsMode != EMegaLightsMode::Disabled)          <span class="cm">// MegaLights가 최우선</span>
        <span class="kw">return</span> MegaLightsMode == EMegaLightsMode::EnabledVSM
             ? ELightOcclusionType::MegaLightsVSM
             : ELightOcclusionType::MegaLights;

    <span class="kw">return</span> bUseRaytracing ? ELightOcclusionType::Raytraced    <span class="cm">// 이 글의 주인공</span>
                          : ELightOcclusionType::Shadowmap;   <span class="cm">// VSM / CSM 경로</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
눈여겨볼 점이 둘 있다. 첫째, <strong><a href="/megalights">MegaLights</a>가 레거시 레이트레이싱 섀도우보다 우선</strong>한다. MegaLights가 관리하는 광원은 이 글이 다루는 <code>RenderRayTracingShadows</code> 경로를 아예 타지 않고, MegaLights 고유의 확률적 광원 샘플링 안에서 그림자 광선을 쏜다(→ 09장). 둘째, Raytraced로 판정된 광원은 그 광원의 그림자 전체가 레이트레이싱으로 <strong>대체</strong>된다 — 섀도우 맵 투영(<code>RenderDeferredShadowProjections</code>)은 상호 배타적인 <code>else</code> 분기다. 두 기법이 한 광원 안에서 섞이지 않는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그럼 <code>bUseRaytracing</code>은 어떻게 정해지나. 프로젝트 전역 스위치와 광원별 오버라이드의 조합이다.
</p>

<div class="code-block"><div class="code-lang">C++ — LightRendering.cpp (광원별 활성 판정 요지)</div><span class="kw">bool</span> <span class="fn">ShouldRenderRayTracingShadowsForLight</span>(..., <span class="ty">ECastRayTracedShadow::Type</span> CastRayTracedShadow)
{
    <span class="kw">if</span> (!<span class="fn">ShouldRenderRayTracingEffect</span>(...) || !<span class="fn">ShouldRenderRayTracingShadowsForLightType</span>(LightType))
        <span class="kw">return</span> <span class="kw">false</span>;                 <span class="cm">// RT 미지원 or 타입별 CVar off</span>

    <span class="kw">switch</span> (CastRayTracedShadow)
    {
    <span class="kw">case</span> ECastRayTracedShadow::Enabled:           <span class="kw">return</span> <span class="kw">true</span>;   <span class="cm">// 광원이 강제 ON</span>
    <span class="kw">case</span> ECastRayTracedShadow::UseProjectSetting: <span class="kw">return</span> <span class="fn">ShouldRenderRayTracingShadows</span>(...);  <span class="cm">// r.RayTracing.Shadows 따름</span>
    <span class="kw">default</span>:                                      <span class="kw">return</span> <span class="kw">false</span>;  <span class="cm">// Disabled</span>
    }
}</div>

<p style="color:var(--text2);line-height:1.85;">
에디터에서 광원의 <strong>Cast Ray Traced Shadows</strong> 드롭다운(Use Project Setting / Enabled / Disabled)이 이 스위치문이다. 이 구조 덕에 "주인공을 비추는 rect light 하나만 레이트레이싱, 나머지는 VSM" 같은 <strong>광원 단위 하이브리드</strong>가 설정만으로 성립한다. 타입별 게이트(<code>r.RayTracing.Shadows.Lights.Directional/Point/Spot/Rect</code>, 기본 모두 1)도 따로 있어 "포인트 라이트만 RT 끄기" 같은 조정도 가능하다.
</p>

<div class="callout callout-info">
<div class="callout-title">결과물은 같은 자리에 꽂힌다</div>
<p>어느 경로든 최종 산출물은 <strong>ScreenShadowMaskTexture</strong> — 라이팅 패스가 광원 감쇠에 곱하는 화면 크기 마스크다. 레이트레이싱 경로는 이 텍스처를 광선 추적 + 디노이징으로 채우고, 섀도우 맵 경로는 깊이 비교 투영으로 채울 뿐, 이후 라이팅 파이프라인은 두 경로를 구분하지 않는다. 그림자 기법과 라이팅이 깔끔하게 분리돼 있다.</p>
</div>

<span class="section-eyebrow">03 — dispatch</span>
</div>

# RenderRayTracingShadows: scissor로 자르고, TLAS에 쏜다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
실제 디스패치는 <code>FDeferredShadingSceneRenderer::RenderRayTracingShadows()</code>(<code>RayTracingShadows.cpp</code>)다. 흐름을 순서대로 펼치면 이렇다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">1</div><div class="step-name">Scissor</div><div class="step-desc">광원의 화면 영향 범위로 트레이스 영역 절단</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">2</div><div class="step-name">Light 파라미터</div><div class="step-desc">SourceRadius × ShadowSourceAngleFactor</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">3</div><div class="step-name">Permutation</div><div class="step-desc">광원 타입·디노이저 모드·헤어·SPP 조합 선택</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">4</div><div class="step-name">Trace</div><div class="step-desc">RGS 또는 inline CS로 TLAS Base 레이어에 광선</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">5</div><div class="step-name">Denoise</div><div class="step-desc">SSD ShadowVisibilityMask (라이트 4개 배칭)</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>Scissor</strong>가 첫 번째 컬링 장치다. <code>LightSceneProxy->GetScissorRect()</code>로 광원의 감쇠 반경이 화면에서 차지하는 사각형을 구해, 디스패치 해상도 자체를 그 크기로 줄이고(<code>bClipDispatch</code>) 셰이더에도 <code>LightScissor</code>·<code>PixelOffset</code>을 넘겨 밖의 픽셀은 광선을 쏘지 않는다. 스포트라이트 하나가 화면 구석만 비추면 그 구석만큼만 광선이 나간다. UE 4.23에서 "광원 scissor를 반영한다"는 성능 개선이 들어온 뒤로 이 경로의 기본 구조다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>광원 파라미터</strong>에서 재미있는 한 줄 — <code>Light.SourceRadius *= LightSceneProxy->GetShadowSourceAngleFactor()</code>. 라이팅에 쓰는 광원 크기와 그림자 페넘브라에 쓰는 광원 크기를 <strong>따로</strong> 잡을 수 있게 해준다. 아티스트가 스페큘러 하이라이트는 그대로 두고 그림자만 더/덜 부드럽게 만들 수 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>Trace</strong>는 두 가지 모드다. RT 파이프라인 셰이더를 지원하는 RHI에서는 raygen 셰이더 <code>FOcclusionRGS</code>를 <code>RayTraceDispatch</code>로, 그렇지 않고 inline RT만 지원하면 같은 셰이더 본문을 컴파일한 컴퓨트 셰이더 <code>FOcclusionCS</code>(wave32, 8×4 그룹)를 디스패치한다. 광선이 향하는 가속 구조는 <code>View.GetRayTracingSceneLayerViewChecked(ERayTracingSceneLayer::Base)</code> — <a href="/lumen">Lumen</a> HWRT와 <strong>공유하는 씬 TLAS의 Base 레이어</strong>다. 그림자 전용 BVH를 따로 만들지 않는다. Nanite 지오메트리도 이 TLAS를 통해 참여하는데, 실제 렌더링되는 풀 디테일이 아니라 <strong>fallback mesh</strong>가 들어간다는 점이 뒤에서(→ 08장) 문제가 된다.
</p>

<div class="code-block"><div class="code-lang">C++ — RayTracingShadows.cpp (디스패치 요지)</div><span class="cm">// 출력 두 장: 마스크(FloatRGBA)와 디노이저용 히트 거리(R16F)</span>
RayTracingOcclusion         = ...;  <span class="cm">// PF_FloatRGBA — Shadow / ClosestRayDistance / Transmission</span>
RayTracingOcclusionDistance = ...;  <span class="cm">// PF_R16F   — 평균 히트 거리 (출력 모드 1에서 사용)</span>

<span class="kw">const bool</span> bInlineRayTracing = !GRHISupportsRayTracingShaders &amp;&amp; GRHISupportsInlineRayTracing;
<span class="kw">if</span> (bInlineRayTracing)
    FComputeShaderUtils::<span class="fn">Dispatch</span>(..., <span class="ty">FOcclusionCS</span>, ...);          <span class="cm">// DXR 1.1 RayQuery 경로</span>
<span class="kw">else</span>
    RHICmdList.<span class="fn">RayTraceDispatch</span>(Pipeline, <span class="ty">FOcclusionRGS</span>, ...);      <span class="cm">// raygen 경로</span>

<span class="cm">// r.RayTracing.Shadows.EnableMaterials 0이면: 머티리얼 any-hit 없이</span>
<span class="cm">// 기본 hit/miss만 묶은 최소 파이프라인 구성 — 마스크드 그림자 포기, 속도 확보</span></div>

<p style="color:var(--text2);line-height:1.85;">
<strong>배칭</strong>도 이 단계에서 같이 처리된다. 연속한 레이트레이싱 광원 최대 <code>r.RayTracing.Shadows.MaxBatchSize</code>(8)개를 몰아서 추적하고, 디노이징 큐가 <code>r.Shadow.Denoiser.MaxBatchSize</code>(4)개 차면 <code>DenoiseShadowVisibilityMasks()</code>로 한꺼번에 밀어낸다(→ 06장). 광원마다 디노이저를 따로 세팅하는 고정비를 나누는 구조다. UE 4.23 릴리스 노트가 "디노이즈 여부와 무관하게 모든 RT 그림자를 배칭한다"고 밝힌 구조가 5.8까지 그대로 이어진다.
</p>

<span class="section-eyebrow">04 — soft shadows</span>
</div>

# 소프트 섀도우: 광원을 점이 아니라 입체각으로 샘플링한다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
페넘브라(반그림자)가 생기는 원리는 단순하다 — 표면 점에서 <strong>면광원의 일부만</strong> 보이면 그만큼만 밝다. 오클루더에 붙은 지점은 광원이 다 가려지거나 다 보이거나 둘 중 하나라 경계가 날카롭고, 멀어질수록 "일부만 보이는" 영역이 넓어져 그림자가 부드러워진다. 레이트레이싱 섀도우는 이걸 몬테카를로로 푼다. <strong>광원 표면의 임의 지점을 향해 광선을 쏘고, 뚫린 광선의 비율이 곧 가시성</strong>이다.
</p>

<div class="formula">visibility ≈ (1/N) Σ V(x → light sample_i)     ← N개 광선 중 몇 개가 광원에 닿았나</div>

<p style="color:var(--text2);line-height:1.85;">
UE 5.8의 레이 생성 셰이더 <code>GenerateOcclusionRay()</code>(<code>RayTracingOcclusionRGS.usf</code>)는 이 샘플링을 광원 타입별 전용 코드로 구현한다. 페넘브라 크기를 결정하는 파라미터가 에디터의 <strong>Source Angle / Source Radius / Source Length / Barn Width</strong>인 이유가 여기 있다 — 이 값들이 곧 샘플링 도메인의 크기다.
</p>

<div class="data-table">
<table>
<tr><th>광원 타입</th><th>샘플링 방식 (소스)</th><th>페넘브라 파라미터</th></tr>
<tr><td><strong>Directional</strong></td><td>광원 방향 주변 콘 샘플링 — <code>UniformSampleConeRobust(u, SinThetaMax²)</code>, <code>RayTMax = 1e27</code> (<code>RayTracingDirectionalLight.ush</code>)</td><td><code>Source Angle</code> (기본 0.5357° — 실제 태양의 각지름)</td></tr>
<tr><td><strong>Point / Spot</strong></td><td>구 광원 입체각 샘플링 — 바깥에서는 <code>SinThetaMax² = R²/d²</code> 콘, 구 내부에서는 면적 샘플링. <code>SourceLength &gt; 0</code>이면 캡슐 버전 (<code>RayTracingSphereLight.ush</code>)</td><td><code>Source Radius</code>, <code>Source Length</code></td></tr>
<tr><td><strong>Rect</strong></td><td>spherical rectangle 균등 샘플링 — <code>BuildSphericalRect / UniformSampleSphericalRect</code>, 광원 법선 뒤쪽은 컬링 (<code>RayTracingRectLight.ush</code>)</td><td>사각 광원의 폭·높이</td></tr>
</table>
</div>

<div class="code-block"><div class="code-lang">HLSL — RayTracingDirectionalLight.ush (콘 샘플링 요지)</div><span class="cm">// SourceRadius에는 이미 GetShadowSourceAngleFactor()가 곱해져 들어옴 (03장)</span>
<span class="kw">float</span> SinThetaMax = LightParameters.SourceRadius;      <span class="cm">// 태양의 각반경 → 콘 반각</span>

<span class="cm">// 광원 방향을 축으로 하는 콘 안의 임의 방향 하나 — 프레임·픽셀·샘플마다 다른 난수</span>
<span class="kw">float4</span> DirAndPdf = <span class="fn">UniformSampleConeRobust</span>(RandSample, SinThetaMax * SinThetaMax);
Ray.Direction = <span class="fn">TangentToWorld</span>(DirAndPdf.xyz, LightParameters.Direction);
Ray.TMax      = <span class="num">1e27</span>;                                  <span class="cm">// directional은 무한대까지</span></div>

<p style="color:var(--text2);line-height:1.85;">
샘플 개수는 광원의 <strong>Samples Per Pixel</strong> 속성이 정하고(<code>r.RayTracing.Shadows.SamplesPerPixel</code>이 -1이 아니면 전역 오버라이드), 다중 샘플은 <code>ENABLE_MULTIPLE_SAMPLES_PER_PIXEL</code> 퍼뮤테이션으로 컴파일된다. 실전 기본값은 <strong>1 spp</strong>다 — 픽셀당 광선 하나로 페넘브라를 적분하는 건 어림도 없으니, 매 프레임 다른 지점을 샘플링하고(난수 시퀀스가 <code>View.StateFrameIndex</code>를 시드에 포함) 나머지는 디노이저가 시공간으로 메운다. "노이즈는 페넘브라에만 생긴다"는 점이 중요하다 — 완전히 밝거나 완전히 가려진 픽셀은 어느 샘플이든 같은 답이 나와 1 spp로도 노이즈가 없다. 디노이저가 지워야 할 것은 오직 반그림자 띠다.
</p>

<div class="callout callout-warn">
<div class="callout-title">spp를 올리는 게 능사가 아니다</div>
<p>UE 문서 스스로 "샘플을 늘려도 디노이저 때문에 품질 향상이 정체된다"고 밝힌다. 디노이저가 시공간에서 이미 유효 샘플을 불려주기 때문에, 페넘브라가 아주 넓은 씬이 아니라면 1→4 spp의 비용 증가만큼 화질이 따라오지 않는다. Ray Tracing Gems의 적응형 샘플링(페넘브라로 판정된 픽셀에만 광선을 더 쏘는 방식, RTX 2080 Ti에서 균일 4 spp 3.6ms 대비 적응형 0–5 spp 2.7ms)이 노리는 것도 같다 — <strong>광선은 페넘브라에만 쓴다</strong>는 것이다.</p>
</div>

<span class="section-eyebrow">05 — OcclusionRGS 내부</span>
</div>

# RayTracingOcclusionRGS.usf: 광선 한 발의 방어 장치들

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
레이 생성 셰이더의 픽셀당 흐름은 이렇다. GBuffer(또는 Substrate)에서 깊이·법선·셰이딩 모델을 읽고, 라이팅 채널이 맞는 유효 픽셀인지 확인한 뒤, 광원 타입별 샘플링(04장)으로 광선을 만들고, 방어 장치 몇 겹을 거쳐 <code>TraceVisibilityRay</code>를 부른다. 이 장에서는 그 장치들이 실제 코드에서 어떻게 생겼는지를 하나씩 본다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>① Normal bias.</strong> 레이트레이싱에도 shadow acne가 있다 — 부동소수점 정밀도 때문에 표면에서 출발한 광선이 <em>자기 자신</em>과 교차 판정되는 셀프 인터섹션이다. 1차 방어는 광선 원점을 법선 방향으로 밀어내는 것: <code>ApplyCameraRelativeDepthBias(..., NormalBias)</code>, 기본값 <code>r.RayTracing.NormalBias</code> = 0.1(약 1mm). 흥미로운 디테일 — 스텐실 최하위 비트로 dithered LOD 전환 중인 프리미티브를 식별해 <strong>bias를 0.8 추가</strong>한다. LOD가 디졸브로 바뀌는 중인 메시는 래스터와 RT 지오메트리가 어긋나 있어 여유가 더 필요하기 때문이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>② Epsilon 이중 트레이스.</strong> bias만으로 부족한 겹친 지오메트리를 위한 2차 방어다. <code>AVOID_SELF_INTERSECTION_TRACE</code> 퍼뮤테이션이 켜지면, 본 광선 전에 길이 <code>r.RayTracing.Shadows.AvoidSelfIntersectionTraceDistance</code>(1.0)의 <strong>짧은 광선을 backface 컬링 강제로 먼저</strong> 쏜다. 이 짧은 광선이 빗나가면 본 광선의 <code>TMin</code>을 그 너머로 밀어 재추적한다. 출발점 주변 1유닛 안의 지오메트리(대부분 자기 자신이거나 같은 평면의 이웃 삼각형)를 통째로 건너뛰는 방식이다. 휴리스틱 bias는 콘텐츠에 따라 씬마다 값을 다시 잡아야 한다는 게 문제인데, NVIDIA는 부동소수점 오차의 상한을 계산해 오프셋을 정하는 방법을 제안한 바 있다. UE의 짧은 트레이스는 그 사이에서 고른 실전 절충안이다.
</p>

<div class="code-block"><div class="code-lang">HLSL — RayTracingOcclusionRGS.usf (트레이스 요지)</div><span class="cm">// two-sided가 아니면 backface 컬링 — 단면 벽의 뒷면 히트 방지</span>
<span class="kw">uint</span> RayFlags = bTwoSidedGeometry ? <span class="num">0</span> : RAY_FLAG_CULL_BACK_FACING_TRIANGLES;

<span class="cm">// 섀도우 레이의 정석: 첫 히트에서 종료 (r.RayTracing.Shadows.AcceptFirstHit)</span>
<span class="kw">const uint</span> RayFlagsForOpaque = bAcceptFirstHit ? RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH : <span class="num">0</span>;

<span class="cm">// 마스크: 그림자 캐스터로 표시된 지오메트리만 순회 (TLAS 인스턴스 마스크)</span>
<span class="kw">uint</span> RaytracingMask = RAY_TRACING_MASK_SHADOW | RAY_TRACING_MASK_THIN_SHADOW;

<span class="ty">FMinimalPayload</span> Payload = <span class="fn">TraceVisibilityRay</span>(TLAS, RayFlags | RayFlagsForOpaque,
                                             RaytracingMask, PixelCoord, Ray);
<span class="cm">// TraceVisibilityRay는 SHADOW_RAY 플래그 + "반투명 머티리얼 무시"를 설정 —</span>
<span class="cm">// any-hit은 마스크드(알파 테스트) 평가에만 쓰인다</span></div>

<p style="color:var(--text2);line-height:1.85;">
<strong>③ 마스크드 머티리얼.</strong> 이 셰이더는 any-hit 셰이더만 동적으로 바인딩해 컴파일된다(closest-hit·miss는 기본형). <code>r.RayTracing.Shadows.EnableMaterials</code>(1)이 켜져 있으면 머티리얼의 any-hit이 알파 테스트와 dithered LOD 전환을 평가해 나뭇잎 구멍이 그림자에도 뚫린다. 끄면 01장의 트레이드오프 그대로 — 전부 불투명 취급이라 빨라지지만 마스크드 그림자가 틀려진다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>④ 반투명 그림자.</strong> 기본 트레이스는 반투명 머티리얼을 아예 무시한다. <code>r.RayTracing.Shadows.Translucency</code>(기본 0)를 켜면, 불투명 트레이스가 <strong>빗나간 경우에 한해</strong> <code>RAY_TRACING_MASK_TRANSLUCENT_SHADOW</code> 마스크로 두 번째 광선을 쏘아 반투명 표면들의 <code>ShadowVisibility</code> 휘도를 누적한다(히트 수 상한 <code>MaxTranslucencyHitCount</code>). 이 CVar는 TLAS 빌드에도 관여한다 — 켜는 순간 반투명 지오메트리가 가속 구조에 포함돼야 하므로(<code>SetRayTracingSceneOptions</code>), 씬 전체의 BVH 비용이 올라간다. raygen 경로 전용이라 inline CS 모드에서는 지원되지 않는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>⑤ 출력.</strong> 결과는 디노이저 모드 퍼뮤테이션(<code>DIM_DENOISER_OUTPUT</code>)에 따라 다르게 패킹된다. 내장 디노이저가 요구하는 모드 2(<code>PenumbraAndClosestOccluder</code>)에서는 <code>float4(Shadow, ClosestRayDistance, 0, TransmissionDistance)</code> — R에 가시성, <strong>G에 가장 가까운 오클루더까지의 히트 거리</strong>를 쓴다. 이 거리가 디노이저의 블러 반경을 정하는 핵심 신호다(→ 06장). 디노이저가 필요 없는 하드 섀도우는 모드 0으로, 섀도우 맵 경로와 동일한 light attenuation 채널 인코딩(<code>EncodeLightAttenuation</code>)에 바로 쓴다. 헤어 스트랜드는 <code>RAY_TRACING_MASK_THIN_SHADOW</code>로 별도 트레이스해 sub-pixel 마스크에 쓰되, <strong>의도적으로 디노이징하지 않는다</strong> — 머리카락 폭의 고주파 디테일은 디노이저가 지워버리기 때문이다.
</p>

<span class="section-eyebrow">06 — denoising</span>
</div>

# 디노이저: 1 spp 페넘브라를 살려내는 시공간 필터

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
디노이저가 필요한지부터 광원이 결정한다. <code>LightRequiresDenoiser()</code>는 directional은 <code>SourceAngle &gt; 0</code>, point/spot은 <code>SourceRadius &gt; 0</code>, rect는 항상 참을 돌려준다 — 즉 <strong>페넘브라가 생기는 광원만</strong> 디노이징한다. 크기 0의 광원은 1 spp로도 노이즈가 없으니(04장) 그대로 쓴다.
</p>

<p style="color:var(--text2);line-height:1.85;">
UE 내장 디노이저는 <code>IScreenSpaceDenoiser</code> 인터페이스의 <code>DenoiseShadowVisibilityMasks()</code>(<code>ScreenSpaceDenoise.cpp</code>)다. 입력은 05장의 출력 그대로 — 가시성 마스크와 <strong>closest occluder 거리</strong>, 그리고 광원 정보(위치·반경·방향·타입). 신호 처리 종류는 <code>ESignalProcessing::ShadowVisibilityMask</code>로, 히스토리는 <code>FLightComponentId</code>를 키로 광원마다 따로 관리된다. 내부 패스는 SSD(Screen Space Denoiser) 프레임워크의 5단계다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">1</div><div class="step-name">Injest</div><div class="step-desc">신호 압축·메타데이터 준비</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">2</div><div class="step-name">Reconstruction</div><div class="step-desc">공간 재구성 — 주변 8샘플로 결측 메움</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">3</div><div class="step-name">Pre-convolution</div><div class="step-desc">사전 블러 패스</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">4</div><div class="step-name">Temporal</div><div class="step-desc">히스토리 재투영 누적</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">5</div><div class="step-name">History conv.</div><div class="step-desc">히스토리 안정화 블러</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
핵심 아이디어는 <strong>히트 거리로 블러 반경을 결정</strong>하는 것이다. 오클루더가 표면에 바짝 붙어 있으면(히트 거리 짧음) 페넘브라가 좁으니 블러도 좁아야 하고, 오클루더가 멀면 페넘브라가 넓으니 넓게 블러해도 안전하다. SSD가 광원별로 <code>HitDistanceToWorldBluringRadius</code>를 계산해 배열로 셰이더에 넘기는 이유다. 무차별 가우시안이 아니라 <strong>광원 기하와 히트 거리를 아는 필터</strong>라는 점이, 그림자 경계는 날카롭게 유지하면서 페넘브라 노이즈만 지울 수 있게 한다. NVIDIA가 UE4 시네마틱 데모("Reflections", "Speed of Light")에서 검증한 방식을 그대로 잇는다 — 픽셀당 광선 1개를 광원 크기·방향·히트 거리에 맞춰 이방성으로 필터링하고, temporal 누적으로 유효 8–16 spp를 만드는 방식이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
비용 구조에서 중요한 사실: <strong>디노이징은 광원마다 따로</strong> 돈다. 필터가 광원별 정보를 쓰기 때문에 여러 광원의 그림자를 한 버퍼에 합쳐 디노이징할 수 없고, 비용이 광원 수에 선형이다. UE가 광원 4개(<code>r.Shadow.Denoiser.MaxBatchSize</code>)를 한 디스패치에 <strong>배칭</strong>하는 것은 이 선형 비용의 고정비(패스 세팅, 텍스처 왕복)를 나누는 장치지, 필터 자체를 공유하는 게 아니다.
</p>

<div class="callout callout-purple">
<div class="callout-title">비교 — NVIDIA NRD SIGMA</div>
<p>업계 표준 외부 디노이저인 NRD 라이브러리는 그림자 전용 디노이저 <strong>SIGMA</strong>를 따로 둔다. 범용 radiance 디노이저(REBLUR 2.30ms, RELAX 3.00ms — RTX 4080·1440p)보다 훨씬 싼 <strong>0.40ms</strong>에 돌고, 요구하는 입력도 UE SSD와 같다 — 표면에서 광원을 향해 쏜 가시성 광선의 <strong>히트/미스 + 오클루더 거리</strong>. temporal 안정화는 최대 7프레임으로 짧게 잡는데(REBLUR/RELAX는 수십~수백 프레임), 그림자는 광원·물체가 움직일 때 즉각 따라와야 하는 신호라서다. 그림자 디노이저는 범용 디노이저를 줄여 쓰는 것이 아니라 따로 풀어야 하는 문제라는 게 벤더들의 공통된 결론이다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
디노이저 앞단의 노이즈 품질도 결과를 좌우한다. Ray Tracing Gems II는 섀도우 레이 난수로 <strong>blue noise</strong>를 권한다 — 오차가 고주파에만 몰려 있어 가우시안 계열 저역 필터가 거의 완전히 지울 수 있는 반면, white noise는 저주파 오차가 필터를 통과해 얼룩으로 남는다. NRD 문서도 4–8프레임 주기로 애니메이션되는 blue noise 패턴을 권장한다. <a href="/denoising">디노이징 글</a>에서 다룬 일반론이 그림자에도 그대로 통한다.
</p>

<span class="section-eyebrow">07 — vs shadow map</span>
</div>

# 섀도우 맵과의 승부: 언제 이기고, 언제 지고, 어떻게 섞나

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
"레이트레이싱 그림자가 더 정확하다"는 건 이제 논쟁거리가 아니다. 남은 문제는 그 정확도를 얼마에 사느냐다. Ray Tracing Gems 1의 측정(RTX 2080 Ti·1080p, 2048² CSM + EVSM 대비)이 이 관계를 잘 보여준다 — <strong>광원 4개 씬에서는 RT 하드 섀도우가 섀도우 맵보다 40–60% 빨랐고, 광원 1개 씬에서는 섀도우 맵이 약 2배 빨랐다</strong>. 섀도우 맵은 광원마다 씬을 다시 그리는 고정비가 크고, RT는 픽셀당 광선 비용이 광원 수만큼 쌓이되 씬 재렌더링이 없다. 어느 쪽이 유리한지는 광원 수와 씬 복잡도, 그리고 필요한 페넘브라 품질에 따라 갈린다.
</p>

<div class="data-table">
<table>
<tr><th>기준</th><th>섀도우 맵 (CSM/VSM)</th><th>레이트레이싱 섀도우</th></tr>
<tr><td>정확도</td><td>해상도 의존 — 앨리어싱·faceting·acne·peter panning. VSM이 크게 완화</td><td>픽셀 정확. 기하학적 아티팩트 원천 없음</td></tr>
<tr><td>소프트 섀도우</td><td>PCF/PCSS 근사 — 큰 면광원에서 물리적으로 틀림</td><td>면광원 샘플링으로 물리적으로 올바른 페넘브라</td></tr>
<tr><td>비용 구조</td><td>광원당 씬 재렌더링(캐싱 가능). 화면 밖 지오메트리도 비용</td><td>픽셀×광원×spp 광선 비용 + 디노이저 + TLAS 유지비</td></tr>
<tr><td>캐싱</td><td>정적 씬이면 프레임 간 재사용 가능</td><td>화면 공간 결과라 카메라가 움직이면 전부 재계산</td></tr>
<tr><td>콘텐츠 제약</td><td>바이어스 튜닝, 캐스케이드 설정</td><td>BVH에 들어갈 지오메트리 관리 (Nanite fallback 등)</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
"캐싱" 행이 실전에서 자주 결정적이다. 섀도우 맵은 정적 광원 + 정적 씬이면 이전 프레임 것을 재사용할 수 있지만, RT 그림자는 화면 공간 결과라 카메라만 움직여도 전부 다시 쏴야 한다. Ray Tracing Gems 1이 "중요한 광원은 레이트레이싱, 정적·보조 광원은 섀도우 맵"의 하이브리드를 결론으로 권하는 이유다. UE의 광원 단위 선택 구조(02장)가 바로 그 권고를 그대로 구현한 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
더 공격적인 하이브리드는 <strong>한 광원 안에서</strong> 두 기법을 섞는다. AMD <strong>FidelityFX Hybrid Shadows</strong>가 대표적이다 — 섀도우 맵(캐스케이드) 결과로 픽셀을 분류해, 확실히 밝거나 확실히 어두운 픽셀은 광선을 아예 쏘지 않고 <strong>애매한(페넘브라) 픽셀에만</strong> 레이트레이싱한다. 여기에 섀도우 맵의 깊이 정보로 광선의 t 구간을 줄이는 <strong>ray interval reduction</strong>까지 얹는다. 분류 품질이 관건인데, 한 독립 구현 실험에서는 12샘플 Poisson 필터 분류로 풀 레이트레이싱 대비 면적 광원 그림자 비용을 96.1ms → 15.2ms(비 RT 하드웨어의 컴퓨트 트레이싱 기준)까지 줄였다고 보고한다 — 단, 광원 시점의 깊이 복잡도가 높은 영역(처마 밑 등)에서는 분류가 실패한다는 한계도 있다.
</p>

<div class="callout callout-info">
<div class="callout-title">UE 5.8 안의 세 번째 선택지 — VSM의 SMRT</div>
<p>이름이 헷갈리기 쉬운데, <a href="/virtualshadowmap">Virtual Shadow Map</a>의 <strong>SMRT(Shadow Map Ray Tracing)</strong>는 하드웨어 레이트레이싱이 아니다. 섀도우 맵 텍스처 <em>안에서</em> 광선을 행진시켜 소프트 섀도우를 근사하는 기법으로, BVH도 shadow ray도 없다. "레이트레이싱 같은 페넘브라"의 상당 부분을 섀도우 맵 인프라 위에서 얻는 절충안이라, UE 5.8의 그림자 선택지는 사실상 VSM(+SMRT) / 레거시 RT 섀도우 / MegaLights 삼파전이다.</p>
</div>

<span class="section-eyebrow">08 — 최적화</span>
</div>

# 성능: 광선을 아끼는 다섯 가지 방법과 CVar 정리

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
이 파이프라인의 최적화 수단을 층위별로 모으면 다섯 가지다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">① 순회 조기 종료</div>
<div class="card-title">AcceptFirstHit</div>
<div class="card-desc">"뭐라도 맞았나"만 물으니 첫 히트에서 순회 종료. <code>r.RayTracing.Shadows.AcceptFirstHit</code>(1). 01장의 정석 플래그가 CVar로 노출된 것.</div>
</div>
<div class="card teal">
<div class="card-label">② 화면 컬링</div>
<div class="card-title">광원 scissor</div>
<div class="card-desc">광원 감쇠 반경의 화면 사각형으로 디스패치 자체를 절단. 로컬 광원이 많은 씬에서 효과가 크다. 화면 구석 스포트라이트는 구석만큼만 광선을 쓴다.</div>
</div>
<div class="card purple">
<div class="card-label">③ 지오메트리 컬링</div>
<div class="card-title">인스턴스 마스크 + r.RayTracing.Culling</div>
<div class="card-desc">TLAS 인스턴스의 8비트 마스크(<code>RAY_TRACING_MASK_SHADOW</code>)로 그림자 비캐스터를 순회에서 제외. 거리/크기 기반 컬링은 <code>r.RayTracing.Culling.*</code>.</div>
</div>
<div class="card gold">
<div class="card-label">④ 광선 예산</div>
<div class="card-title">spp와 적응형 샘플링</div>
<div class="card-desc">기본 1 spp + 디노이저. 노이즈가 페넘브라에만 생기니 페넘브라에만 광선을 더 쓰는 적응형(RTG1: 균일 4spp 3.6ms → 적응형 2.7ms)이 이상적이다.</div>
</div>
<div class="card coral">
<div class="card-label">⑤ 배칭</div>
<div class="card-title">트레이스 8개 · 디노이즈 4개</div>
<div class="card-desc">광원별 고정비(패스 세팅·중간 텍스처)를 배치로 상각. <code>MaxBatchSize</code> 두 개가 각각 트레이스·디노이즈 배치 크기.</div>
</div>
</div>

<div class="data-table">
<table>
<tr><th>CVar</th><th>기본값</th><th>꽂히는 지점</th></tr>
<tr><td><code>r.RayTracing.Shadows</code></td><td>0</td><td>프로젝트 전역 스위치 (광원의 UseProjectSetting이 참조)</td></tr>
<tr><td><code>r.RayTracing.Shadows.Lights.Directional / Point / Spot / Rect</code></td><td>1</td><td>광원 타입별 게이트 (02장)</td></tr>
<tr><td><code>r.RayTracing.Shadows.SamplesPerPixel</code></td><td>-1</td><td>-1이면 광원별 SPP 사용, 아니면 전역 오버라이드 (04장)</td></tr>
<tr><td><code>r.RayTracing.Shadows.AcceptFirstHit</code></td><td>1</td><td>순회 조기 종료 플래그 (05장)</td></tr>
<tr><td><code>r.RayTracing.Shadows.EnableMaterials</code></td><td>1</td><td>마스크드 머티리얼 any-hit 평가 (05장)</td></tr>
<tr><td><code>r.RayTracing.NormalBias</code></td><td>0.1</td><td>광선 원점 법선 오프셋 (05장)</td></tr>
<tr><td><code>r.RayTracing.Shadows.AvoidSelfIntersectionTraceDistance</code></td><td>1.0</td><td>epsilon 이중 트레이스 길이 (05장)</td></tr>
<tr><td><code>r.RayTracing.Shadows.EnableTwoSidedGeometry</code></td><td>1</td><td>양면 그림자 캐스팅 — Nanite fallback 얼룩과 트레이드오프</td></tr>
<tr><td><code>r.RayTracing.Shadows.Translucency</code> / <code>MaxTranslucencyHitCount</code></td><td>0 / -1</td><td>반투명 그림자 + TLAS 반투명 포함 (05장)</td></tr>
<tr><td><code>r.RayTracing.Shadows.MaxBatchSize</code></td><td>8</td><td>트레이스 배칭 (03장)</td></tr>
<tr><td><code>r.Shadow.Denoiser</code> / <code>.MaxBatchSize</code></td><td>2 / 4</td><td>디노이저 선택(0 off / 1 내장 강제 / 2 플러그인 허용) · 디노이즈 배칭 (06장)</td></tr>
<tr><td><code>r.RayTracing.Shadows.LODTransitionStart / End</code></td><td>4000 / 5000</td><td>헤어·SSS 원거리 LOD 전환 (40–50m)</td></tr>
</table>
</div>

<div class="callout callout-warn">
<div class="callout-title">Nanite 주의보 — 그림자는 fallback mesh를 본다</div>
<p>Nanite 지오메트리는 TLAS에 풀 디테일이 아니라 <strong>fallback mesh</strong>로 들어간다. 화면에 래스터되는 메시와 광선이 맞는 메시의 실루엣이 어긋나므로, 하드한 RT 그림자에서 셀프 섀도잉 얼룩이 생길 수 있다. 완화책은 세 가지 — <code>AvoidSelfIntersectionTraceDistance</code>를 키우거나, 스태틱 메시의 <strong>Fallback Relative Error</strong>를 0에 가깝게 낮춰 fallback을 촘촘하게 만들거나(빌드 비용 증가), <code>r.RayTracing.Shadows.EnableTwoSidedGeometry 0</code>으로 얼룩을 지우는 대신 단면 메시의 그림자를 포기하거나. 어느 쪽도 공짜가 아니라 콘텐츠 사정에 맞춰 골라야 한다.</p>
</div>

<span class="section-eyebrow">09 — MegaLights</span>
</div>

# 5.8의 방향: 광원당 풀스크린 패스에서 픽셀당 확률적 광선으로

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
이 글이 추적한 경로의 구조적 한계는 분명하다 — <strong>광원마다</strong> 풀스크린(scissor 내) 트레이스 + 디노이즈가 돈다. 광원 8개면 8번이다. 광원 수십·수백 개 시대에 이 구조로는 감당이 안 된다. UE 5.8에서 <code>GetLightOcclusionType()</code>이 MegaLights를 최우선으로 두는 것(02장)이 이 한계에 엔진이 내놓은 답이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<a href="/megalights">MegaLights</a>는 루프를 뒤집는다. 광원마다 화면을 도는 대신, <strong>픽셀마다 확률적으로 고른 소수의 광원 샘플</strong>에만 그림자 광선을 쏜다(<code>MegaLightsHardwareRayTracing.usf</code>의 <code>HardwareRayTraceLightSamples</code>). 광원이 아무리 많아도 픽셀당 광선 수가 고정이라 비용이 광원 수와 거의 무관해진다. 그림자 판정 방식도 광원 단위 선택이다 — <code>EMegaLightsShadowMethod</code>가 RayTracing이면 이 글과 같은 TLAS 광선을, VirtualShadowMap이면 VSM 조회를 쓴다(<code>MegaLightsVSMTracing.usf</code>). 디노이저도 SSD가 아니라 MegaLights 전용 spatial/temporal 패스다. 레거시 경로와 달리 광선이 <code>RAY_FLAG_SKIP_CLOSEST_HIT_SHADER</code>를 기본으로 하되 transmission을 위해 HitT는 챙기는 등, 섀도우 레이 최적화의 기본 수법은 그대로 쓴다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 5.8 기준으로 이 레거시 RT 섀도우 경로가 놓인 자리는 <strong>"MegaLights를 안 쓰는(또는 못 쓰는) 광원의 고품질 그림자 전용 경로"</strong>다. 시네마틱처럼 광원 몇 개의 페넘브라 품질이 중요할 때는 여전히 이 경로가 광선 예산을 광원당 spp로 직접 제어할 수 있는 정공법이고, 광원이 많은 게임 씬에서는 MegaLights가 확률적 예산으로 전체를 커버한다. 같은 TLAS와 같은 RAY_FLAG 조합을 쓰면서 예산 배분만 다르다. 두 경로의 관계는 이 한 줄로 정리된다.
</p>

<span class="section-eyebrow">정리</span>
</div>

# 정리

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
한 문장으로 압축하면 이렇다. <strong>광원마다 scissor로 자른 화면 영역에서, 광원의 기하 크기(SourceAngle/Radius)가 정하는 입체각을 향해 픽셀당 광선을 쏘고, 첫 히트에서 순회를 끊어 비용을 아끼고, 가시성과 가장 가까운 오클루더까지의 거리를 기록한 뒤, 그 1 spp 페넘브라 노이즈를 광원 기하를 아는 시공간 디노이저(4개 배칭)로 정리해 ScreenShadowMaskTexture에 채워 넣는다.</strong> 섀도우 맵이라는 중간 표현을 없앤 대가로 노이즈와 디노이저를 떠안은 구조다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">직진하는 가시성</div>
<div class="card-title">중간 표현이 없다</div>
<div class="card-desc">광원 시점 렌더링을 경유하지 않으니 acne·peter panning·해상도 앨리어싱이 원천에서 사라진다. 남는 문제는 노이즈 하나.</div>
</div>
<div class="card teal">
<div class="card-label">입체각 = 페넘브라</div>
<div class="card-title">Source Angle/Radius의 정체</div>
<div class="card-desc">에디터의 광원 크기 파라미터가 곧 콘/구면 샘플링 도메인. 접촉부는 날카롭고 멀수록 부드러운 페넘브라가 샘플링에서 자연히 나온다.</div>
</div>
<div class="card gold">
<div class="card-label">첫 히트 종료</div>
<div class="card-title">섀도우 레이의 정석</div>
<div class="card-desc">"뭐라도 맞았나"만 물으니 ACCEPT_FIRST_HIT + SKIP_CLOSEST_HIT + (불투명이면) FORCE_OPAQUE. 히트 시 셰이더가 하나도 안 도는 광선.</div>
</div>
<div class="card purple">
<div class="card-label">디노이저가 절반</div>
<div class="card-title">1 spp를 살리는 기술</div>
<div class="card-desc">노이즈는 페넘브라에만 생기고, 블러 반경은 히트 거리가 정한다. 광원별 필터라 비용은 광원 수에 선형 — 그래서 4개 배칭.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
계보로 보면 이 경로는 UE4.22(2019, Shadow of the Tomb Raider와 같은 세대)에 들어온 1세대 DXR 기능이 광원 단위 하이브리드·배칭·inline RT 지원으로 다듬어진 형태다. 그리고 다음 세대는 이미 들어와 있다 — 광원당 풀스크린 패스라는 구조적 비용을 픽셀당 확률적 샘플링으로 바꾼 <a href="/megalights">MegaLights</a>, 섀도우 맵 인프라 위에서 페넘브라를 근사하는 <a href="/virtualshadowmap">VSM의 SMRT</a>. 그림자 하나에 세 경로가 공존하는 지금의 UE는 "가시성 질문에 예산을 얼마나 쓸 것인가"를 아직 하나로 정리하지 못한 상태를 그대로 보여준다.
</p>

<span class="section-eyebrow">참고</span>

<div class="card-grid" style="grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));">
<div class="card blue">
<div class="card-label">1차 출처</div>
<div class="card-title">Unreal Engine 5.8 소스</div>
<div class="card-desc"><code>LightRendering.cpp</code>, <code>RayTracing/RayTracingShadows.cpp</code>, <code>RayTracingOcclusionRGS.usf</code>, <code>RayTracing{Directional,Sphere,Rect}Light.ush</code>, <code>ScreenSpaceDenoise.cpp</code>, <code>MegaLights/*</code>. 이 글의 모든 코드 흐름·CVar의 출처.</div>
</div>
<div class="card purple">
<div class="card-label">API 사양</div>
<div class="card-title">DirectX Raytracing Spec · DXR 1.1</div>
<div class="card-desc"><a href="https://microsoft.github.io/DirectX-Specs/d3d/Raytracing.html">microsoft.github.io/DirectX-Specs</a> — 섀도우 레이 플래그 조합의 정의와 권고. inline raytracing(RayQuery)은 <a href="https://devblogs.microsoft.com/directx/dxr-1-1/">DXR 1.1 발표문</a>.</div>
</div>
<div class="card teal">
<div class="card-label">이론·측정</div>
<div class="card-title">Ray Tracing Gems 1 &amp; 2</div>
<div class="card-desc">RTG1 ch.13 "Ray Traced Shadows"(Boksanský, Wimmer, Bittner) — 적응형 샘플링·CSM 대비 측정. RTG2 ch.24(Boksanský) — 광원각 샘플링·blue noise·하이브리드 예산 전략.</div>
</div>
<div class="card gold">
<div class="card-label">디노이저·하이브리드</div>
<div class="card-title">NVIDIA NRD · AMD FidelityFX</div>
<div class="card-desc"><a href="https://github.com/NVIDIA-RTX/NRD">NRD(SIGMA)</a> — 그림자 전용 디노이저 설계와 비용. <a href="https://gpuopen.com/fidelityfx-hybrid-shadows/">FidelityFX Hybrid Shadows</a> — 섀도우 맵 분류 기반 페넘브라 한정 레이트레이싱.</div>
</div>
</div>
</div>
