---
layout: post
title: "UE5 Hardware Ray Tracing Architecture: 래스터라이제이션의 한계부터 BVH·DXR·SBT·payload까지 — 언리얼은 광선을 어떻게 쏘는가"
icon: paper
permalink: raytracing-shader
categories: Rendering
tags: [ComputerGraphics, Rendering, UnrealEngine, RayTracing, DXR, BVH, AccelerationStructure, ShaderBindingTable, Lumen]
excerpt: "레이 트레이싱이 처음이어도 따라올 수 있게 바닥부터 시작한다 — 래스터라이제이션은 화면을 어떻게 그려왔고 무엇을 못 하는지, 광선 하나가 카메라에서 픽셀 색이 되기까지 어떻게 움직이는지, 그리고 삼각형 1000만 개 앞에서 왜 BVH가 필요한지. 그 위의 본론은 언리얼의 하드웨어 레이 트레이싱 아키텍처다. 하드웨어는 BVH 빌드·TraceRay·hit group이라는 원시 부품만 준다. 언리얼의 진짜 일은 그 위의 조율이다 — BLAS를 언제 빌드하고 refit하고 compaction할지, TLAS를 매 프레임 어떻게 다시 만들지, payload를 64바이트에 어떻게 패킹할지, 그리고 SBT의 인덱싱 산수로 광선을 올바른 셰이더에 어떻게 꽂을지. 이 글은 UE 5.8 소스(D3D12RayTracing.cpp · RayTracingScene · RayTracingShaderBindingTable · RayTracingCommon.ush)를 코드로 끝까지 추적하고, DXR 스펙과 NVIDIA 모범 사례가 언리얼의 어떤 상수·조건으로 살아 있는지 대조한다. 마지막으로 Shadows·Lumen·MegaLights·Path Tracer가 이 한 벌의 인프라를 어떻게 나눠 쓰는지 정리한다."
back_color: "#ffffff"
img_name: "raytracing-architecture-core-sketch-white.webp"
toc: false
show: true
new: true
series: -1
index: 26
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - 레이 트레이싱을 처음 배우는 분 — 그 이전에는 화면을 어떻게 그렸는지(rasterization), 광선 하나가 카메라에서 픽셀 색이 되기까지 어떤 길을 가는지, BVH가 왜 필요한지부터 차근차근 알고 싶은 분
> - `TraceRay` 한 줄이 GPU에서 실제로 무슨 부품들을 깨우는지 — raygen·any-hit·closest-hit·miss·intersection의 역할이 궁금한 분
> - BLAS와 TLAS가 뭐가 다르고, 언리얼이 왜 정적 메시는 "한 번 빌드", TLAS는 "매 프레임 재빌드"로 나누는지 알고 싶은 분
> - 스키닝·WPO 메시처럼 매 프레임 변형되는 지오메트리의 BVH를 refit할지 rebuild할지 언리얼이 어떤 기준으로 정하는지 궁금한 분
> - SBT(Shader Binding Table)의 그 악명 높은 hit group 인덱싱 산수를 언리얼이 자기 할당자로 어떻게 관리하는지 보고 싶은 분
> - payload를 왜 64바이트에 비트 패킹하는지, Lumen은 왜 그걸 12바이트로 더 줄이는지 이유가 궁금한 분
> - Ray Traced Shadows·Lumen·MegaLights·Path Tracer가 사실 같은 RT 인프라 한 벌을 나눠 쓴다는 게 코드로 어떻게 드러나는지 알고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - 래스터라이제이션이 화면을 그리는 방식과 그 구조적 한계 — 그림자·반사·간접광이 왜 전부 우회책이었는지
> - Camera → Ray → Hit → Material → Color로 이어지는 광선 하나의 움직임, 그리고 삼각형 1000만 개 문제를 BVH가 푸는 원리
> - 하드웨어가 주는 것(BVH·TraceRay·hit group)과 언리얼이 얹는 것(스케줄링·패킹·라우팅)의 경계선
> - `FRayTracingGeometry`(BLAS)와 `FRayTracingScene`(TLAS)의 구조, 그리고 정적/동적/캐시드 인스턴스가 나뉘는 방식
> - BLAS 빌드가 즉시가 아니라 **우선순위 예산 큐**로 돌아가는 이유와 `MaxBuiltPrimitivesPerFrame` 예산 로직
> - compaction이 왜 멀티 프레임 비동기 파이프라인일 수밖에 없는지 — DXR의 리드백 제약과 NVIDIA가 말하는 "최대 50% 절감"
> - refit(update)와 rebuild의 트레이드오프, 그리고 `ForceBuild` 조건이 BVH 품질 저하를 막는 원리
> - TLAS를 매 프레임 GPU에서 인스턴스 컬링·디스크립터 작성으로 다시 만드는 태스크 파이프라인
> - hit group 레코드 인덱스 = `InstanceContribution + GeometryIndex × 2 + RayContribution`이 SBT 할당자로 관리되는 법
> - payload 계층(`FMinimalPayload`→`FPackedMaterialClosestHitPayload` 64B→`FLumenMinimalPayload` 12B)과 그 크기가 성능에 직결되는 이유
> - `RAY_TRACING_ENTRY_RAYGEN_OR_INLINE`이 어떻게 한 소스로 RGS와 inline CS 두 경로를 동시에 유지하는지
> - Shadows·Lumen HWRT·MegaLights·Path Tracer가 payload와 SBT를 어떻게 나눠 쓰는지 한눈에 보는 표

<br>

{% include research-post-style.html %}

<div class="research-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# 개요: 하드웨어가 주는 부품과, 엔진이 해야 하는 조율

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
GPU에 레이 트레이싱 전용 유닛이 들어가면서 렌더링 엔지니어의 일이 하나 줄었다고 생각하기 쉽다. "광선을 쏘고 부딪히는 삼각형을 찾는" 그 무식하게 비싼 계산을 이제 하드웨어가 대신 해주니까. 맞는 말이지만, 하드웨어가 해주는 것은 정확히 거기까지다 — <strong>광선 하나를 빨리 쏘는 능력</strong>. 그 능력을 실제 게임 화면으로 만들려면, 엔진이 채워야 하는 일이 산더미로 남는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
예를 들면 이런 일들이다. 광선이 삼각형을 빨리 찾으려면 씬의 삼각형들을 <strong>검색하기 좋은 자료구조</strong>로 미리 정리해 둬야 하는데(03장에서 설명할 BVH다), 씬에 메시가 수만 개면 그 자료구조도 수만 개다. 매 프레임 전부 새로 만들면 광선을 쏘기도 전에 프레임이 끝나니 — 어떤 것은 한 번 만들어 계속 쓰고, 어떤 것은 캐릭터가 움직인 만큼만 고쳐 쓰고, 어떤 것은 바쁘면 다음 프레임으로 미뤄야 한다. 크게 잡아둔 메모리는 틈틈이 회수해야 하고, 광선이 무언가에 맞았을 때 <strong>그 물체의 머티리얼 셰이더</strong>가 정확히 실행되도록 연결표를 관리해야 하고, 광선 하나하나가 들고 다니는 데이터는 바이트 단위로 아껴야 한다. 하나같이 하드웨어가 안 해주는, 엔진의 일이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 글의 본론이 바로 그 <strong>엔진의 일</strong>이다. 언리얼 엔진 5.8 소스를 따라 — 메시 하나의 검색 구조가 만들어지고, 압축되고, 움직이는 메시를 따라 갱신되고, 씬 하나로 묶이고, 광선이 올바른 셰이더에 연결되어 결과를 들고 돌아오기까지 — 하드웨어 위에 언리얼이 얹은 층을 끝까지 추적한다. 그리고 그 위에서 Ray Traced Shadows, Lumen, MegaLights, Path Tracer가 <strong>같은 인프라 한 벌</strong>을 어떻게 나눠 쓰는지 정리한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
다만 본론이 무겁기 때문에, 처음 세 장은 바닥부터 깐다 — 레이 트레이싱 이전에는 화면을 어떻게 그렸고 무엇을 못 했는지(01장), 광선 하나가 카메라에서 픽셀 색이 되기까지 어떻게 움직이는지(02장), 그리고 삼각형 1000만 개 앞에서 왜 BVH라는 자료구조가 필요한지(03장). <strong>레이 트레이싱이 처음이라면 01장부터 순서대로</strong> 읽으면 되고, DXR에 이미 익숙하다면 04장(파이프라인 정리)나 05장(BLAS)로 바로 건너뛰어도 된다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
<p>1차 출처는 로컬 UE 5.8 소스(<code>D:\UnrealEngine_5_8</code>)다 — <code>D3D12RHI/Private/D3D12RayTracing.cpp</code>, <code>Renderer/Private/RayTracing/RayTracingScene.{h,cpp}</code> · <code>RayTracingShaderBindingTable.cpp</code> · <code>RayTracingMaterialHitShaders.cpp</code>, <code>Engine/Shaders/Private/RayTracing/RayTracingCommon.ush</code>, 그리고 활용처의 <code>RayTracingShadows.cpp</code> · <code>LumenHardwareRayTracing*</code> · <code>PathTracing.cpp</code>. 파일:라인은 5.8 체크아웃 기준이라 버전이 바뀌면 달라질 수 있다. DXR 개념·모범 사례는 <strong>Microsoft DXR 스펙</strong>과 <strong>NVIDIA RTX 레이 트레이싱 모범 사례/compaction 블로그</strong>에서 직접 대조·검증했다(하단 참고).</p>
</div>

<span class="section-eyebrow">01 — 래스터라이제이션</span>
</div>

# 레이 트레이싱 이전: 래스터라이제이션은 어떻게 그려왔는가

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
언리얼 이야기에 들어가기 전에, 처음 배우는 사람을 위해 바닥부터 깔자. 실시간 3D 그래픽스는 30년 가까이 한 가지 방법으로 화면을 그려왔다 — <strong>래스터라이제이션(rasterization)</strong>이다. 절차는 이렇다. 씬의 삼각형을 하나씩 꺼내서, 카메라 기준으로 <strong>화면에 투영</strong>하고(멀리 있는 것은 작게), 그 삼각형이 화면에서 <strong>덮는 픽셀들을 찾아</strong> 픽셀마다 색을 계산한다<span class="fn-note"><input type="checkbox" id="fn-shader" class="fn-toggle"><label for="fn-shader" class="fn-ref">1</label><span class="fn-body"><strong>셰이더(shader):</strong> GPU에서 실행되는 작은 프로그램. 래스터 파이프라인에서는 정점을 화면 좌표로 옮기는 버텍스 셰이더, 픽셀 하나의 색을 계산하는 픽셀 셰이더가 대표다. 레이 트레이싱에는 전용 셰이더가 여섯 종류 따로 있는데 04장에서 정리한다.</span></span>. 삼각형끼리 겹치면 깊이(카메라까지의 거리)를 비교해 더 가까운 쪽만 남긴다. 이걸 삼각형 수백만 개에 반복하면 한 프레임이 완성된다. 질문의 방향에 주목하자 — 래스터라이제이션은 <strong>"이 삼각형이 화면의 어떤 픽셀을 덮는가"</strong>를 묻는다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 640 250" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace">
<defs><marker id="rtx-ah-gray" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#414455"/></marker></defs>
<!-- 왼쪽: 씬의 삼각형 -->
<path d="M 105,45 L 45,185 L 200,160 Z" fill="rgba(10,143,114,0.18)" stroke="#0a8f72" stroke-width="1.6"/>
<text x="118" y="135" fill="#0a8f72" font-size="11" text-anchor="middle">씬의 삼각형</text>
<text x="122" y="218" fill="#7e8295" font-size="11" text-anchor="middle">3D 월드 공간</text>
<!-- 가운데: 투영 화살표 -->
<line x1="222" y1="120" x2="332" y2="120" stroke="#414455" stroke-width="1.6" marker-end="url(#rtx-ah-gray)"/>
<text x="277" y="106" fill="#414455" font-size="11" text-anchor="middle">화면에 투영</text>
<!-- 오른쪽: 덮인 픽셀 채우기 -->
<g fill="rgba(67,56,202,0.5)">
<rect x="440" y="50" width="20" height="20"/>
<rect x="420" y="70" width="20" height="20"/><rect x="440" y="70" width="20" height="20"/><rect x="460" y="70" width="20" height="20"/>
<rect x="420" y="90" width="20" height="20"/><rect x="440" y="90" width="20" height="20"/><rect x="460" y="90" width="20" height="20"/><rect x="480" y="90" width="20" height="20"/>
<rect x="420" y="110" width="20" height="20"/><rect x="440" y="110" width="20" height="20"/><rect x="460" y="110" width="20" height="20"/><rect x="480" y="110" width="20" height="20"/>
<rect x="400" y="130" width="20" height="20"/><rect x="420" y="130" width="20" height="20"/><rect x="440" y="130" width="20" height="20"/><rect x="460" y="130" width="20" height="20"/><rect x="480" y="130" width="20" height="20"/><rect x="500" y="130" width="20" height="20"/>
<rect x="400" y="150" width="20" height="20"/><rect x="420" y="150" width="20" height="20"/><rect x="440" y="150" width="20" height="20"/><rect x="460" y="150" width="20" height="20"/><rect x="480" y="150" width="20" height="20"/><rect x="500" y="150" width="20" height="20"/><rect x="520" y="150" width="20" height="20"/>
<rect x="400" y="170" width="20" height="20"/><rect x="420" y="170" width="20" height="20"/><rect x="440" y="170" width="20" height="20"/>
</g>
<!-- 픽셀 그리드 -->
<path d="M360,30 V210 M380,30 V210 M400,30 V210 M420,30 V210 M440,30 V210 M460,30 V210 M480,30 V210 M500,30 V210 M520,30 V210 M540,30 V210 M560,30 V210 M580,30 V210" stroke="rgba(123,130,150,0.35)" stroke-width="1" fill="none"/>
<path d="M360,30 H580 M360,50 H580 M360,70 H580 M360,90 H580 M360,110 H580 M360,130 H580 M360,150 H580 M360,170 H580 M360,190 H580 M360,210 H580" stroke="rgba(123,130,150,0.35)" stroke-width="1" fill="none"/>
<!-- 투영된 삼각형 윤곽 -->
<path d="M 450,45 L 380,190 L 560,165 Z" fill="none" stroke="#4338ca" stroke-width="1.6"/>
<text x="470" y="238" fill="#7e8295" font-size="11" text-anchor="middle">화면 — 삼각형이 덮는 픽셀만 칠한다</text>
</svg>
<div class="scene-cap">래스터라이제이션 — 삼각형을 화면에 투영해서, 덮는 픽셀을 칠한다. 픽셀 하나를 칠하는 순간 셰이더가 아는 것은 지금 그리는 이 삼각형 하나뿐이다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 방법은 압도적으로 빠르다. 삼각형 하나를 그리는 데 다른 삼각형의 정보가 전혀 필요 없으니, GPU가 수백만 개를 병렬로 밀어낼 수 있다. 하지만 바로 그 장점이 구조적인 맹점이 된다 — <strong>픽셀을 칠하는 순간, 셰이더는 자기 삼각형 하나밖에 모른다.</strong> 씬의 나머지는 볼 수 없다. 그런데 화면을 사실적으로 만드는 효과들은 하필 전부 "<strong>다른 물체</strong>"에 대한 질문이다.
</p>

<div class="card-grid">
<div class="card coral">
<div class="card-label">그림자</div>
<div class="card-title">"나와 광원 사이에 뭐가 있나?"</div>
<div class="card-desc">래스터의 답 — <strong>섀도우맵</strong>: 광원 시점에서 씬을 한 번 더 렌더링해 깊이를 저장해 두고 비교한다. 텍스처 해상도가 유한해 계단 현상·빛샘 같은 아티팩트가 따라온다.</div>
</div>
<div class="card gold">
<div class="card-label">반사</div>
<div class="card-title">"이 표면에 어떤 물체가 비치나?"</div>
<div class="card-desc">래스터의 답 — <strong>SSR·리플렉션 프로브</strong>: 이미 화면에 그려진 픽셀을 재활용하거나, 미리 찍어둔 큐브맵을 쓴다. 화면 밖이나 가려진 물체는 반사에 나타나지 않는다.</div>
</div>
<div class="card purple">
<div class="card-label">간접광</div>
<div class="card-title">"다른 표면에서 튕겨온 빛은?"</div>
<div class="card-desc">래스터의 답 — <strong>라이트맵·프로브</strong>: 오프라인에 미리 굽거나, 드문드문한 지점에서 근사한다. 움직이는 물체와 바뀌는 조명에 약하다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
즉 래스터라이제이션 자체는 "카메라에 보이는 표면 찾기"까지만 답하고, 그림자·반사·간접광은 각각 <strong>별도의 우회책을 쌓아</strong> 흉내 내온 것이다. 우회책마다 전제 조건과 아티팩트가 있고, 서로 따로 놀며, 렌더러 코드의 상당 부분이 이 우회책들의 유지보수다. 그런데 위의 세 질문은 사실 하나의 질문으로 환원된다 — <strong>"이 지점에서 저 방향으로 곧게 나아가면, 무엇에 맞는가?"</strong> 광원 방향으로 물으면 그림자고, 반사 방향으로 물으면 반사고, 사방으로 물으면 간접광이다. 이 질문에 우회 없이 직접 답하는 방법이 <strong>레이 트레이싱(ray tracing)</strong>이다.
</p>

<span class="section-eyebrow">02 — 광선 하나</span>
</div>

# 광선 하나는 어떻게 움직이는가: Camera → Ray → Hit → Color

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
레이 트레이싱은 질문의 방향을 뒤집는다. 래스터라이제이션이 "삼각형이 어떤 픽셀을 덮는가"를 물었다면, 레이 트레이싱은 <strong>"픽셀에서 나간 광선이 무엇에 맞는가"</strong>를 묻는다. 광선(ray)은 시작점(origin)과 방향(direction)을 가진 반직선이다. 카메라에서 픽셀 하나를 지나도록 광선을 만들어 씬으로 내보내고, 그 광선이 <strong>처음 맞는 삼각형</strong>을 찾고, 맞은 지점의 머티리얼과 조명을 평가해 색을 얻고, 그 색을 픽셀에 기록한다. 과정 전체가 여섯 단계다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">1 · Camera</div><div class="step-name">픽셀 선택</div><div class="step-desc">화면의 픽셀 하나를 고른다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">2 · Ray</div><div class="step-name">광선 생성</div><div class="step-desc">카메라에서 그 픽셀을 지나는 광선을 만든다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">3 · Triangle</div><div class="step-name">교차 검사</div><div class="step-desc">씬의 삼각형들과 교차하는지 검사한다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">4 · Hit</div><div class="step-name">최근접 확정</div><div class="step-desc">가장 가까운 교차점 하나를 확정한다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">5 · Material</div><div class="step-name">셰이딩</div><div class="step-desc">그 지점의 머티리얼·조명을 평가한다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">6 · Color</div><div class="step-name">색 기록</div><div class="step-desc">결과 색을 픽셀에 써넣는다</div></div>
</div>

<div class="scene-fig">
<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace">
<defs>
<marker id="rtx-ah-blue" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4338ca"/></marker>
<marker id="rtx-ah-gold" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#b07d00"/></marker>
<marker id="rtx-ah-coral" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d6304a"/></marker>
</defs>
<!-- 카메라 -->
<rect x="22" y="104" width="30" height="32" rx="4" fill="rgba(65,71,89,0.15)" stroke="#414455" stroke-width="1.4"/>
<path d="M 52,112 L 66,120 L 52,128 Z" fill="#414455"/>
<text x="38" y="158" fill="#7e8295" font-size="11" text-anchor="middle">카메라</text>
<!-- 화면(픽셀 그리드) -->
<path d="M92,78 V162 M104,78 V162 M116,78 V162 M128,78 V162 M140,78 V162 M152,78 V162" stroke="rgba(123,130,150,0.4)" stroke-width="1" fill="none"/>
<path d="M92,78 H152 M92,90 H152 M92,102 H152 M92,114 H152 M92,126 H152 M92,138 H152 M92,150 H152 M92,162 H152" stroke="rgba(123,130,150,0.4)" stroke-width="1" fill="none"/>
<rect x="116" y="114" width="12" height="12" fill="rgba(67,56,202,0.85)"/>
<text x="122" y="184" fill="#7e8295" font-size="11" text-anchor="middle">화면(픽셀)</text>
<!-- 광선 -->
<line x1="66" y1="122" x2="450" y2="106" stroke="#4338ca" stroke-width="2" marker-end="url(#rtx-ah-blue)"/>
<text x="255" y="102" fill="#4338ca" font-size="12" text-anchor="middle">Ray</text>
<!-- 삼각형과 히트 -->
<path d="M 440,38 L 418,158 L 560,128 Z" fill="rgba(180,83,9,0.14)" stroke="#b45309" stroke-width="1.6"/>
<circle cx="458" cy="105" r="4.5" fill="#d6304a"/>
<text x="505" y="178" fill="#d6304a" font-size="11" text-anchor="middle">Hit — 가장 가까운 교차</text>
<!-- 광원과 그림자 광선 -->
<circle cx="300" cy="32" r="9" fill="rgba(176,125,0,0.25)" stroke="#b07d00" stroke-width="1.4"/>
<path d="M300,16 V10 M300,48 V54 M284,32 H278 M316,32 H322 M289,21 L285,17 M311,21 L315,17 M289,43 L285,47 M311,43 L315,47" stroke="#b07d00" stroke-width="1.2"/>
<text x="337" y="26" fill="#b07d00" font-size="11">광원</text>
<line x1="452" y1="99" x2="310" y2="42" stroke="#b07d00" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#rtx-ah-gold)"/>
<text x="362" y="76" fill="#b07d00" font-size="10.5" text-anchor="middle">그림자 광선 — 막히면 그늘</text>
<!-- 색 반환 -->
<path d="M 455,114 C 390,208 220,208 130,130" fill="none" stroke="#d6304a" stroke-width="1.3" stroke-dasharray="4 4" marker-end="url(#rtx-ah-coral)"/>
<text x="300" y="222" fill="#d6304a" font-size="10.5" text-anchor="middle">Color — 평가한 색을 픽셀에 기록</text>
</svg>
<div class="scene-cap">광선 하나의 움직임 — 카메라에서 픽셀을 지나 나간 광선이 가장 가까운 삼각형에 맞고, 그 지점의 머티리얼·조명을 평가한 색이 픽셀로 돌아온다. 히트 지점에서 광원으로 쏘는 두 번째 광선이 그림자를 판정한다.</div>
</div>

<div class="code-block"><div class="code-lang">의사 코드 — 레이 트레이싱의 뼈대</div><span class="kw">for</span> (각 픽셀)
{
    Ray = 카메라에서 픽셀 중심을 지나는 광선;        <span class="cm">// origin + direction</span>
    Hit = <span class="fn">씬에서_가장_가까운_교차</span>(Ray);            <span class="cm">// ← 비용의 전부가 이 한 줄 (03장)</span>
    <span class="kw">if</span> (Hit.있음)  색 = <span class="fn">머티리얼</span>(Hit) × <span class="fn">조명</span>(Hit);  <span class="cm">// 맞은 지점을 셰이딩</span>
    <span class="kw">else</span>          색 = 하늘;                        <span class="cm">// 아무것도 못 맞음 = miss</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
이 구조가 강력한 이유는 <strong>광선을 어디서든, 어느 방향으로든 쏠 수 있다</strong>는 데 있다. 카메라에서만 쏘라는 법이 없다. 히트 지점에서 광원을 향해 하나 더 쏘면 — 중간에 뭐라도 맞으면 그 지점은 그림자다. 01장에서 우회책을 쌓아야 했던 세 질문이 전부 광선 하나짜리 질문으로 바뀐다: 반사 방향으로 쏘면 화면 밖 물체까지 정확히 비치는 반사가 되고, 표면 위 반구 방향으로 여러 개 쏘면 간접광이 된다. 래스터라이제이션이 효과마다 다른 우회책을 쌓았다면, 레이 트레이싱은 <strong>모든 효과를 "광선 쏘기" 하나로 통일</strong>한다.
</p>

<span class="section-eyebrow">03 — 왜 BVH인가</span>
</div>

# 삼각형이 1000만 개면? — BVH가 필요한 이유

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
02장의 의사 코드에서 시치미 떼고 넘어간 줄이 있다 — "씬에서 가장 가까운 교차". 가장 단순한 구현은 씬의 <strong>모든 삼각형</strong>에 대해 하나씩 교차를 검사하고 그중 가장 가까운 것을 고르는 것이다. 문제는 규모다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">문제</div><div class="step-name">삼각형이 1000만 개면?</div><div class="step-desc">요즘 게임 씬의 평범한 규모</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">순진한 답</div><div class="step-name">전부 검사?</div><div class="step-desc">광선 하나마다 1000만 번 교차 검사</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">결과</div><div class="step-name">너무 느림</div><div class="step-desc">픽셀 200만 × 1000만 = 20조 번/프레임</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">해법</div><div class="step-name">BVH</div><div class="step-desc">상자로 묶어 통째로 걸러낸다 → log N</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
숫자로 보자. 1080p 화면은 픽셀이 약 200만 개고, 그림자·반사까지 계산하려면 픽셀당 광선을 몇 개씩 쏜다. 삼각형 1000만 개짜리 씬에서 픽셀당 광선 하나만 쏴도 교차 검사가 <strong>200만 × 1000만 = 20조 번</strong>이다. 초당 60프레임은커녕 한 프레임에 몇 분이 걸린다. 낭비의 정체는 명확하다 — 광선 하나는 씬의 극히 일부만 지나가는데, 나머지 999만 몇천 개의 삼각형까지 전부 헛검사하는 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
해법은 검사를 빨리 하는 게 아니라 <strong>안 해도 되는 검사를 통째로 걸러내는 것</strong>이다. 가까이 있는 삼각형 몇 개를 상자<span class="fn-note"><input type="checkbox" id="fn-aabb" class="fn-toggle"><label for="fn-aabb" class="fn-ref">2</label><span class="fn-body"><strong>AABB(axis-aligned bounding box):</strong> 물체를 빈틈없이 감싸되 면이 좌표축에 평행한 직육면체. 최소·최대 좌표 여섯 개 숫자로 표현되고, 광선과의 교차 검사가 광선-삼각형 검사보다 훨씬 싸다. BVH의 "상자"가 전부 이것이다.</span></span>로 감싸고, 상자 몇 개를 더 큰 상자로 감싸고 — 이걸 반복해 올라가면 트리가 된다. 이것이 <strong>BVH(Bounding Volume Hierarchy, 경계 볼륨 계층)</strong>다. 광선은 트리 꼭대기의 큰 상자부터 검사하며 내려온다. 상자를 빗나가면? <strong>그 상자 안의 삼각형 전부를 검사 없이 건너뛴다.</strong> 상자를 맞았을 때만 열어서 자식 상자를 검사하고, 맨 아래 잎(leaf)에 도달해야 비로소 진짜 광선-삼각형 검사를 한다. 검사 횟수가 삼각형 개수 N에 비례하지 않고 <strong>log N</strong>에 비례하게 되는 것이다 — 1000만 번이 수십 번 수준으로 줄어든다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace">
<defs><marker id="rtx-ah-blue2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4338ca"/></marker></defs>
<!-- 루트 상자 -->
<rect x="30" y="22" width="580" height="218" fill="none" stroke="rgba(123,130,150,0.45)" stroke-width="1.2" stroke-dasharray="3 4"/>
<text x="42" y="40" fill="#7e8295" font-size="10.5">루트 상자 — 씬 전체</text>
<!-- 상자 A (맞음) -->
<rect x="48" y="52" width="250" height="178" fill="rgba(67,56,202,0.04)" stroke="#4338ca" stroke-width="1.6"/>
<text x="58" y="68" fill="#4338ca" font-size="10.5">A — 상자 맞음 → 연다</text>
<!-- A1 (빗나감) -->
<rect x="64" y="80" width="120" height="68" fill="rgba(123,130,150,0.06)" stroke="#7e8295" stroke-width="1.3" stroke-dasharray="4 3"/>
<path d="M 80,138 l 16,-24 l 14,26 z" fill="rgba(123,130,150,0.25)" stroke="#7e8295" stroke-width="1"/>
<path d="M 124,140 l 18,-20 l 12,22 z" fill="rgba(123,130,150,0.25)" stroke="#7e8295" stroke-width="1"/>
<text x="124" y="95" fill="#7e8295" font-size="10" text-anchor="middle">빗나감 → 스킵</text>
<!-- A2 (맞음) -->
<rect x="64" y="168" width="220" height="52" fill="rgba(67,56,202,0.05)" stroke="#4338ca" stroke-width="1.6"/>
<text x="176" y="181" fill="#4338ca" font-size="10" text-anchor="middle">맞음 → 안의 삼각형만 검사</text>
<path d="M 92,214 l 14,-22 l 13,23 z" fill="rgba(10,143,114,0.2)" stroke="#0a8f72" stroke-width="1.2"/>
<path d="M 182,214 l 16,-26 l 15,26 z" fill="rgba(10,143,114,0.2)" stroke="#0a8f72" stroke-width="1.2"/>
<path d="M 242,213 l 13,-20 l 12,21 z" fill="rgba(10,143,114,0.2)" stroke="#0a8f72" stroke-width="1.2"/>
<!-- 상자 B (빗나감) -->
<rect x="340" y="52" width="255" height="120" fill="rgba(123,130,150,0.06)" stroke="#7e8295" stroke-width="1.3" stroke-dasharray="4 3"/>
<path d="M 360,152 l 14,-22 l 13,23 z" fill="rgba(123,130,150,0.22)" stroke="#7e8295" stroke-width="1"/>
<path d="M 402,150 l 16,-24 l 14,25 z" fill="rgba(123,130,150,0.22)" stroke="#7e8295" stroke-width="1"/>
<path d="M 455,154 l 13,-20 l 12,21 z" fill="rgba(123,130,150,0.22)" stroke="#7e8295" stroke-width="1"/>
<path d="M 505,152 l 17,-26 l 15,27 z" fill="rgba(123,130,150,0.22)" stroke="#7e8295" stroke-width="1"/>
<path d="M 553,150 l 12,-18 l 11,19 z" fill="rgba(123,130,150,0.22)" stroke="#7e8295" stroke-width="1"/>
<text x="467" y="190" fill="#7e8295" font-size="10.5" text-anchor="middle">B — 빗나감 → 안의 삼각형 전부 스킵 (검사 0회)</text>
<!-- 광선 -->
<line x1="2" y1="196" x2="184" y2="196" stroke="#4338ca" stroke-width="2" marker-end="url(#rtx-ah-blue2)"/>
<circle cx="190" cy="196" r="4.5" fill="#d6304a"/>
<text x="34" y="186" fill="#4338ca" font-size="11">광선</text>
<text x="190" y="248" fill="#d6304a" font-size="10.5" text-anchor="middle">잎에서만 삼각형 검사 → 히트</text>
</svg>
<div class="scene-cap">BVH 트래버설 — 광선은 상자부터 검사한다. 빗나간 상자(회색 점선)는 내부 삼각형을 하나도 검사하지 않고 통째로 건너뛰고, 맞은 상자(파란 실선)만 열어 내려간다. 1000만 번의 검사가 수십 번으로 줄어드는 원리다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
그리고 이 <strong>트래버설(traversal)</strong> — 광선이 트리를 타고 내려가며 교차를 찾는 과정 — 은 하드웨어에 넣기 딱 좋은 모양이다. "상자 검사 → 맞으면 자식으로, 빗나가면 다음으로"의 단순 반복이라 회로로 굳히기 쉽고, 픽셀 수백만 개가 서로 독립적으로 같은 일을 하니 병렬화도 완벽하다. 그래서 2018년 NVIDIA RTX(Turing) 세대부터 GPU에 광선-상자·광선-삼각형 교차를 전담하는 <strong>RT 코어</strong>가 들어갔고, 이것을 그래픽 API 표준으로 노출한 것이 <strong>DXR(DirectX Raytracing)</strong>이다. 단, 경계선을 정확히 긋자 — 하드웨어가 대신해 주는 것은 <strong>트래버설</strong>이지, BVH를 만들고·갱신하고·광선이 맞은 물체에 어떤 셰이더를 실행할지 정하는 일이 아니다. 그건 여전히 엔진의 몫이고, 이 글의 나머지 전부(04~13장)가 바로 그 이야기다.
</p>

<p style="color:var(--text2);line-height:1.85;">
본론에 들어가기 전에, 지금까지의 쉬운 말과 이제부터 나올 DXR 용어를 표 하나로 이어 두자. 뒤에서 낯선 용어가 나오면 이 표로 돌아오면 된다.
</p>

<div class="data-table">
<table>
<tr><th>지금까지의 말</th><th>DXR 용어</th><th>자세히 다루는 곳</th></tr>
<tr><td>카메라에서 픽셀마다 광선을 만들어 쏘는 코드</td><td><strong>ray generation</strong> 셰이더 (raygen)</td><td>04장</td></tr>
<tr><td>삼각형들을 감싼 상자 트리</td><td><strong>가속 구조</strong>(acceleration structure) = BVH — 메시 하나의 트리가 <strong>BLAS</strong>, 씬 전체가 <strong>TLAS</strong></td><td>04~09장</td></tr>
<tr><td>광선이 트리를 타고 내려가며 교차를 찾는 과정</td><td><strong>traversal</strong> — RT 코어가 하드웨어로 수행</td><td>04장</td></tr>
<tr><td>가장 가까운 히트 지점에서 실행되는 머티리얼 코드</td><td><strong>closest-hit</strong> 셰이더 (hit group의 일원)</td><td>04장·10장</td></tr>
<tr><td>아무것도 못 맞았을 때 실행되는 코드 (하늘)</td><td><strong>miss</strong> 셰이더</td><td>04장</td></tr>
<tr><td>광선에 실려 다니며 결과를 나르는 데이터</td><td><strong>payload</strong></td><td>11장</td></tr>
<tr><td>"이 물체에 맞으면 이 셰이더"를 정하는 연결표</td><td><strong>SBT</strong> (Shader Binding Table)</td><td>10장</td></tr>
</table>
</div>

<span class="section-eyebrow">04 — DXR 파이프라인</span>
</div>

# `TraceRay` 한 줄이 깨우는 여섯 개의 셰이더 스테이지

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
조율을 이야기하기 전에, 조율의 대상인 하드웨어 파이프라인을 먼저 못 박자. 03장에서 "상자 트리" 하나로 뭉뚱그린 BVH가, 실제 API에서는 <strong>2단계</strong>다. <strong>BLAS</strong>(bottom-level acceleration structure)는 삼각형 메시(또는 프로시저럴 AABB) 하나의 BVH다. <strong>TLAS</strong>(top-level)는 그 BLAS들의 <strong>인스턴스</strong>(변환 행렬 + InstanceID + 마스크 + 플래그)를 다시 묶은 BVH다. 앱은 <code>BuildRaytracingAccelerationStructure()</code>를 호출해 자기 소유의 GPU 메모리에 <strong>불투명(opaque)</strong> 구조를 빌드한다 — 내부 포맷은 드라이버/IHV 소관이라 앱은 들여다보지 못한다. DXR 스펙의 표현 그대로 "bottom-level은 씬을 이루는 building block, top-level은 그 인스턴스들의 집합"이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
광선을 쏘는 쪽은 <strong>여섯 종류의 셰이더 스테이지</strong>로 돌아간다. <code>DispatchRays()</code>가 <strong>ray generation(raygen)</strong> 그리드를 기동하고, raygen이 <code>TraceRay()</code>로 광선을 쏜다. 트래버설 중 BLAS와 교차할 때마다 — 프로시저럴 지오메트리면 <strong>intersection</strong> 셰이더가 교차를 계산하고, 삼각형이면 하드웨어가 처리한다 — <strong>any-hit</strong> 셰이더가 교차마다 호출돼 그 히트를 받아들일지(<code>AcceptHitAndEndSearch</code>) 무시할지(<code>IgnoreHit</code>) 결정한다. 알파 마스킹이 전형적인 용도다. 트래버설이 끝나면 <strong>closest-hit</strong>(가장 가까운 승인된 교차) 또는 <strong>miss</strong>(아무것도 못 맞음) 중 하나가 실행된다. 여기에 셰이더에서 서브루틴처럼 부르는 <strong>callable</strong>까지 여섯이다. 이 중 교차 지점에서 도는 셋 — closest-hit·any-hit·intersection — 은 <strong>hit group</strong>이라는 한 묶음으로 등록된다. 광선이 어떤 물체에 맞으면, 그 물체에 연결된 hit group의 셰이더들이 실행되는 것이다.
</p>

<div class="data-table">
<table>
<tr><th>스테이지</th><th>언제</th><th>역할</th></tr>
<tr><td><strong>ray generation</strong></td><td><code>DispatchRays</code> 그리드마다</td><td>광선 발사의 시작점. <code>TraceRay</code> 호출, 결과를 UAV에 기록</td></tr>
<tr><td><strong>intersection</strong></td><td>프로시저럴 AABB 교차 시</td><td>커스텀 교차 판정(구·볼륨 등). 삼각형은 불필요(HW 처리)</td></tr>
<tr><td><strong>any-hit</strong></td><td>교차 후보마다</td><td>알파 마스킹·반투명 그림자. <code>IgnoreHit</code>로 트래버설 계속 가능</td></tr>
<tr><td><strong>closest-hit</strong></td><td>최근접 승인 교차 1회</td><td>머티리얼 평가·셰이딩. 결과를 payload(광선에 실려 다니는 데이터 — 11장)에 기록</td></tr>
<tr><td><strong>miss</strong></td><td>교차 없음</td><td>환경맵·스카이·"가려지지 않음" 표식</td></tr>
<tr><td><strong>callable</strong></td><td>셰이더가 명시 호출</td><td>라이트 펑션 등 서브루틴 분기</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 여섯 스테이지를 다 쓰는 무거운 경로가 있는가 하면, 파이프라인·SBT(어떤 물체에 맞으면 어떤 셰이더를 실행할지 잇는 연결표 — 10장) 없이 임의의 컴퓨트 셰이더에서 광선을 쏘는 가벼운 경로도 있다. <strong>inline ray tracing(RayQuery)</strong>이다. <code>TraceRayInline</code>은 hit group을 부르지 않고 CS 안에서 트래버설을 직접 돌린다. 언리얼은 "히트 지점에서 <strong>머티리얼 평가가 필요 없는</strong>" 트레이스 — 그림자 가시성, Lumen surface cache 샘플링 — 에는 inline을 우선한다. 이 두 갈래(RGS vs inline)는 11장의 셰이더 구조에서 다시 만난다.
</p>

<div class="callout callout-purple">
<div class="callout-title">언리얼의 위치</div>
<p>핵심 명제 하나를 미리 박아두자. <strong>언리얼은 BVH를 직접 만들지 않는다.</strong> 삼각형을 트리로 나누는 실제 빌드는 드라이버/하드웨어가 하고, 언리얼이 하는 일은 그 빌드를 <strong>"언제, 어떤 우선순위로, 어떤 예산 안에서 요청할지" 스케줄링</strong>하고, 결과 BVH의 <strong>메모리를 관리(compaction·residency)</strong>하고, 광선을 올바른 셰이더로 <strong>라우팅(SBT)</strong>하는 것이다. 이 글의 05~10장은 전부 이 세 가지 조율의 각론이다.</p>
</div>

<span class="section-eyebrow">05 — BLAS</span>
</div>

# BLAS: `FRayTracingGeometry`, 그리고 메시 하나가 BVH가 되기까지

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
BLAS는 언리얼에서 <code>FRayTracingGeometry</code>가 감싼다. RHI 레벨의 설계도가 <code>FRayTracingGeometryInitializer</code>(RHIResources.h)인데, 여기 들어가는 필드가 곧 "이 지오메트리를 어떻게 빌드할지"의 정책이다. 지오메트리 타입(<code>ERayTracingGeometryType</code>)은 세 가지 — 삼각형(<code>RTGT_Triangles</code>, 정점 stride ≥ 12바이트), 프로시저럴 AABB(<code>RTGT_Procedural</code>, intersection 셰이더 필요), 그리고 헤어용 선분-구(<code>RTGT_LinearSweptSpheres</code>, NVAPI 전용)다.
</p>

<p style="color:var(--text2);line-height:1.85;">
지오메트리는 <strong>세그먼트(segment)</strong>들로 쪼개지는데, 세그먼트 하나가 곧 머티리얼 섹션 하나다. <code>FRayTracingGeometrySegment</code>에는 정점 버퍼·오프셋·stride, 첫 프리미티브 인덱스, 프리미티브 개수, 그리고 두 개의 결정적 플래그가 있다 — <strong><code>bForceOpaque</code></strong>(any-hit 셰이더를 아예 끄는 플래그)와 <code>bEnabled</code>. 빌드 정책은 initializer의 세 플래그로 정해진다: <code>bFastBuild=false</code>(빠른 빌드보다 빠른 트레이스 선호), <code>bAllowUpdate=false</code>(refit 불가), <code>bAllowCompaction=true</code>(압축 허용). 여기서 <strong>refit</strong>은 트리를 처음부터 다시 짓지 않고 정점 위치만 바꿔 넣는 값싼 갱신이고(08장에서 자세히), <strong>compaction</strong>은 빌드 때 크게 잡아둔 메모리에서 실제로 쓰는 만큼만 남기고 회수하는 압축이다(07장에서 자세히) — 지금은 이 정도만 알고 넘어가자. 정적 메시의 기본값이 이렇다 — "느리게라도 잘 빌드하고, 한 번 빌드하면 안 바꾸고, 대신 메모리는 압축한다".
</p>

<div class="code-block"><div class="code-lang">C++ — StaticMesh.cpp (SetupRayTracingGeometryInitializer 요지)</div><span class="cm">// FStaticMeshSection 하나 = BLAS 세그먼트 하나</span>
<span class="kw">for</span> (<span class="kw">const</span> <span class="ty">FStaticMeshSection</span>&amp; Section : LOD.Sections)
{
    <span class="ty">FRayTracingGeometrySegment</span> Segment;
    Segment.VertexBuffer   = PositionVertexBuffer;        <span class="cm">// 위치 VB만 필요</span>
    Segment.FirstPrimitive = Section.FirstIndex / <span class="num">3</span>;      <span class="cm">// 인덱스→삼각형</span>
    Segment.NumPrimitives  = Section.NumTriangles;
    Segment.bEnabled       = Section.bVisibleInRayTracing;
    Segment.bForceOpaque   = Section.bForceOpaque;        <span class="cm">// any-hit 셰이더 스킵 여부</span>
    Initializer.Segments.<span class="fn">Add</span>(Segment);
}
Initializer.bFastBuild      = <span class="kw">false</span>;   <span class="cm">// PREFER_FAST_TRACE</span>
Initializer.bAllowUpdate    = <span class="kw">false</span>;   <span class="cm">// refit 안 함</span>
Initializer.bAllowCompaction = <span class="kw">true</span>;    <span class="cm">// 빌드 후 압축</span></div>

<p style="color:var(--text2);line-height:1.85;">
LOD 리소스마다 <code>FRayTracingGeometry</code>가 하나씩 붙는다. 쿠킹 타임에 미리 빌드해둔 오프라인 BVH가 있으면(<code>OfflineData</code>) 런타임 빌드를 건너뛰고 그걸 로드하며, 없으면 런타임에 빌드한다. 여기서 <strong>Nanite</strong>는 특수 케이스다. Nanite 메시는 클러스터가 화면 기준으로 동적으로 바뀌므로 통째로 BVH를 만들 수 없다. 기본값은 <strong>fallback proxy 메시</strong>(저폴리 LOD)로 BLAS를 만드는 것이고(<code>r.RayTracing.Nanite.Mode=0</code>), 하드웨어가 클러스터 단위 AS(CLAS)를 지원하면 모드 2로 올라간다 — 단 <code>SupportsClusterOps</code>가 없으면 자동으로 fallback으로 다운그레이드된다.
</p>

<p style="color:var(--text2);line-height:1.85;">
D3D12 레벨에서 재미있는 디테일 하나. BLAS를 생성하는 시점엔 인덱스 버퍼가 16비트인지 32비트인지 아직 모를 수 있다. 그래서 언리얼은 <strong>두 경우의 prebuild 정보를 모두 구해 큰 쪽(max)으로 버퍼를 잡는다</strong>(<code>TranslateRayTracingGeometryDescs</code>). 빌드 플래그 변환도 여기서 일어난다 — <code>bFastBuild</code>면 <code>PREFER_FAST_BUILD</code>, 아니면 <code>PREFER_FAST_TRACE</code>. 그리고 compaction 플래그(<code>ALLOW_COMPACTION</code>)는 조건이 까다롭다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12RayTracing.cpp (GetRayTracingAccelerationStructureBuildFlags 요지)</div><span class="ty">D3D12_..._BUILD_FLAGS</span> Flags = bFastBuild
    ? PREFER_FAST_BUILD : PREFER_FAST_TRACE;
<span class="kw">if</span> (bAllowUpdate) Flags |= ALLOW_UPDATE;

<span class="cm">// compaction은 "정적 메시"에만 — refit도 fastbuild도 아니고, 충분히 클 때</span>
<span class="kw">if</span> (!bFastBuild &amp;&amp; !bAllowUpdate &amp;&amp; bAllowCompaction
        &amp;&amp; NumPrimitives &gt;= <span class="num">128</span>)
    Flags |= ALLOW_COMPACTION;</div>

<p style="color:var(--text2);line-height:1.85;">
이 조건 — <code>!bFastBuild &amp;&amp; !bAllowUpdate</code> — 이 바로 NVIDIA 모범 사례와 정확히 겹치는 지점이다. NVIDIA compaction 문서는 "<code>PREFER_FAST_BUILD</code>나 <code>ALLOW_UPDATE</code>를 쓰지 않으면 최대 압축을 얻는다"고 명시한다. <code>ALLOW_UPDATE</code>는 refit을 위해 여유 공간을 예약하므로 압축과 상충하기 때문이다. 언리얼의 조건은 이 원리를 코드로 옮긴 것이다. 빌드가 끝나면 버퍼 상태를 <code>BVHWrite→BVHRead</code>로 전환하는 글로벌 배리어를 건다.
</p>

<span class="section-eyebrow">06 — 빌드 스케줄링</span>
</div>

# 빌드는 즉시가 아니라 "예산이 허락하는 만큼": FRayTracingGeometryManager

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
여기가 언리얼 조율의 첫 번째 핵심이다. 메시가 로드됐다고 BLAS를 그 자리에서 빌드하지 않는다. <code>FRayTracingGeometryManager</code>가 빌드 <strong>요청을 큐에 쌓고</strong>, 매 프레임 예산 안에서 우선순위 순으로 처리한다. 이유는 명백하다 — 레벨 스트리밍으로 수천 개 메시가 한 프레임에 몰려 들어오면, 그걸 다 즉시 빌드하다가 프레임이 통째로 멈춘다(hitching). 빌드를 <strong>시간축에 분산</strong>시키는 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
우선순위는 네 단계로, <code>Immediate=1.0</code>, <code>High=0.5</code>, <code>Normal=0.24</code>, <code>Low=0.01</code>의 실수 가중치다. 매 프레임 <code>ProcessBuildRequests</code>(DeferredShadingRenderer가 프레임마다 호출)가 요청을 우선순위 내림차순으로 정렬한 뒤, <strong>프리미티브 예산</strong>(<code>r.RayTracing.Geometry.MaxBuiltPrimitivesPerFrame</code>) 안에서만 빌드하고 초과분은 다음 프레임으로 넘긴다. 기본값은 <strong>-1 = 무제한</strong>이라 기본 동작은 "가능한 다 빌드"지만, 예산을 걸면 프레임당 삼각형 수를 잘라서 프레임 멈춤을 막을 수 있다.
</p>

<div class="callout callout-info">
<div class="callout-title">기아 방지 — priority boost</div>
<p>예산 방식의 함정은 <strong>낮은 우선순위 요청이 영원히 밀리는 것</strong>이다. 언리얼은 처리되지 못한 요청의 우선순위를 매 프레임 <code>+0.001</code>씩 올린다(<code>PendingBuildPriorityBoostPerFrame</code>). Low(0.01)로 들어온 요청도 충분히 오래 기다리면 결국 Normal·High를 추월해 빌드된다. 스케줄러의 고전적인 aging 기법이다. 여기에 scratch 메모리 요구량이 2GiB를 넘으면 그 프레임은 스킵하는 안전장치도 붙어 있다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
빌드된 BVH는 무한정 메모리에 남지 않는다. 언리얼은 <strong>reference 기반 residency</strong>(<code>r.RayTracing.UseReferenceBasedResidency</code>)로 실제 참조되는 지오메트리만 상주시키고 나머지는 evict한다. 상주 풀 크기는 <code>r.RayTracing.ResidentGeometryMemoryPoolSizeInMB=400</code>MB, 항상 상주하는 LOD 수는 <code>NumAlwaysResidentLODs=1</code>이다. 요청 큐·예산·aging·residency — 텍스처 스트리밍에서 익숙한 패턴이 BVH에 그대로 적용된 것이다.
</p>

<span class="section-eyebrow">07 — compaction</span>
</div>

# Compaction: 메모리 절반을 회수하는 멀티 프레임 비동기 파이프라인

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
BVH를 빌드하면 드라이버는 최종 크기를 미리 알 수 없어 <strong>보수적으로 크게</strong> 할당한다. 실제 트리가 자리 잡고 나면 상당한 여유가 남는데, 이걸 압축 복사로 회수하는 것이 compaction이다. NVIDIA에 따르면 일부 게임에서 정적 BLAS 메모리를 <strong>최소 50%</strong>까지 줄인다. 문제는 이게 <strong>한 프레임에 끝날 수 없다</strong>는 것이다. 압축 후 크기를 알려면 GPU가 빌드를 마치고 그 크기를 버퍼에 써낸 뒤, CPU가 그걸 <strong>리드백</strong>해야 하는데, GPU-CPU 동기화는 필연적으로 프레임을 건너뛴다.
</p>

<p style="color:var(--text2);line-height:1.85;">
언리얼의 <code>FD3D12RayTracingCompactionRequestHandler</code>가 이걸 정확히 4단계 비동기 상태 기계로 구현한다. 디바이스마다 매 프레임 <code>Update</code>가 돌며 요청들을 배치로 밀어낸다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">1</div><div class="step-name">RequestCompact</div><div class="step-desc">ALLOW_COMPACTION으로 빌드된 BLAS를 압축 큐에 등록</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">2</div><div class="step-name">Emit size</div><div class="step-desc">배치(최대 64)로 COMPACTED_SIZE postbuild info → 스테이징 버퍼</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">3</div><div class="step-name">Readback</div><div class="step-desc">다음 프레임, sync point 후 CPU가 압축 크기 읽기</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">4</div><div class="step-name">Copy compact</div><div class="step-desc">작은 버퍼 할당 → COPY_MODE_COMPACT 복사 → 버퍼 스왑, 원본 해제</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
배치 크기는 <code>r.D3D12.RayTracing.MaxBatchedCompaction=64</code>로, 리드백 오버헤드를 여러 BLAS에 분산시킨다. 그리고 프리미티브가 <code>Compaction.MinPrimitiveCount=128</code> 미만이면 아예 스킵한다 — 작은 메시는 압축 이득보다 관리 오버헤드가 크기 때문이다(05장의 빌드 조건에서 본 그 128과 같은 문턱값이다).
</p>

<div class="callout callout-purple">
<div class="callout-title">코드가 스펙을 그대로 옮긴 자리</div>
<p>NVIDIA compaction 문서가 서술하는 워크플로 — "<code>ALLOW_COMPACTION</code>으로 빌드 → <code>EmitRaytracingAccelerationStructurePostbuildInfo(COMPACTED_SIZE)</code> → fence로 동기화 후 리드백 → <code>CopyRaytracingAccelerationStructure(COPY_MODE_COMPACT)</code>, 리드백 때문에 <strong>몇 프레임의 지연</strong>이 생김" — 이 문장을 언리얼의 4단계 핸들러와 나란히 놓으면 단계가 1:1로 대응한다. 스펙이 "이렇게 하라"고 한 절차를, 엔진이 배치·문턱값·디바이스별 프레임 루프로 감싼 것이 이 핸들러다.</p>
</div>

<span class="section-eyebrow">08 — refit vs rebuild</span>
</div>

# 매 프레임 변형되는 지오메트리: refit할까, rebuild할까

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
정적 메시는 "한 번 빌드"로 끝이지만, 스키닝 캐릭터나 WPO(월드 포지션 오프셋) 머티리얼처럼 <strong>매 프레임 정점이 움직이는</strong> 지오메트리는 BVH를 계속 갱신해야 한다. 여기서 두 갈래가 있다 — <strong>update(refit)</strong>는 트리 구조는 그대로 두고 정점 위치만 밀어넣어 빠르게 갱신하고, <strong>rebuild</strong>는 트리를 처음부터 다시 짓는다. DXR 스펙은 이 트레이드오프를 못 박는다: "update된 구조는 (갱신 전후 모두) 처음부터 빌드한 정적 구조만큼 트레이싱 성능이 좋지 않다. 다만 update가 빌드보다 빠르다." 게다가 <strong>update는 정점 위치만 바꿀 수 있고 토폴로지(인덱스·삼각형 수)는 못 바꾼다</strong>.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 API 제약이 언리얼의 설계를 가른다. <strong>스키닝은 정점만 움직이고 토폴로지는 불변</strong>이니 refit이 맞고, <strong>씬 구성 자체가 바뀌는 TLAS는 매 프레임 rebuild</strong>가 맞다. 그런데 하드웨어는 스키닝을 모른다 — 본 행렬로 변형된 정점 위치를 누군가 미리 버퍼에 써놓아야 한다. 그 일을 하는 것이 <strong>컴퓨트 셰이더 <code>RayTracingDynamicGeometryConverterCS</code></strong>다. 이 CS는 머티리얼 셰이더로 컴파일되어(WPO·스키닝을 머티리얼 그래프대로 평가) 변형된 정점을 출력 버퍼에 써내고, 그 버퍼로 BLAS를 refit/rebuild한다.
</p>

<div class="code-block"><div class="code-lang">C++ — RayTracingDynamicGeometryUpdateManager.cpp (ClassifyBuildMode 요지)</div><span class="cm">// 기본: bAllowUpdate면 refit(Update)</span>
<span class="ty">EAccelerationStructureBuildMode</span> Mode = bAllowUpdate
    ? <span class="ty">EAccelerationStructureBuildMode</span>::Update
    : <span class="ty">EAccelerationStructureBuildMode</span>::Build;

<span class="cm">// 단, refit을 너무 오래 반복했으면 주기적으로 full rebuild로 강등</span>
<span class="kw">if</span> (ForceBuildMaxPrimitivesPerFrame &gt; <span class="num">0</span>
        &amp;&amp; NumUpdatesSinceLastBuild &gt; MinUpdatesSinceLastBuild)
{
    Mode = <span class="ty">EAccelerationStructureBuildMode</span>::Build;   <span class="cm">// BVH 품질 회복</span>
    NumUpdatesSinceLastBuild = <span class="num">0</span>;
}</div>

<p style="color:var(--text2);line-height:1.85;">
이 <code>ForceBuild</code> 로직이 정확히 NVIDIA 모범 사례가 말하는 것이다 — "<strong>refit을 반복하면 BVH 품질이 점점 저하되므로 주기적으로 rebuild하는 것이 합리적</strong>"이며, "변형이 크고 예측 불가한 지오메트리(폭발 등)는 <code>ALLOW_UPDATE</code>를 생략하고 항상 rebuild하라". 언리얼은 전자를 <code>MinUpdatesSinceLastBuild</code> 카운터로, 후자를 정점 변형이 심한 메시의 빌드 정책으로 구현한다. refit은 공짜가 아니다 — <strong>반복할수록 트리 품질이 떨어지고</strong>, 그 품질을 주기적인 rebuild로 회복시키는 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
효율을 위한 장치도 붙는다. 변형 정점은 공유 버퍼 풀(<code>SharedVertexBufferSizeInMB=4</code>, 30프레임 GC)에서 sub-allocate하고, <strong>tracing feedback</strong>(→ 09장 끝의 노트)을 켜면 "지난 프레임에 실제로 광선이 맞은" 동적 지오메트리만 갱신한다. 화면 뒤에서 아무도 안 보는 캐릭터의 BVH를 매 프레임 다시 만드는 낭비를 막는 것이다.
</p>

<span class="section-eyebrow">09 — TLAS</span>
</div>

# TLAS: 매 프레임 GPU에서 다시 만드는 씬 — FRayTracingScene

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
BLAS들이 준비되면 이제 씬 하나로 묶을 차례다. <code>FRayTracingScene</code>이 TLAS를 관리하는데, 그냥 하나가 아니라 <strong>레이어 3개</strong>로 나뉜다 — <code>Base</code>(일반 지오메트리), <code>Decals</code>(데칼), <code>FarField</code>(Lumen 원거리 전용). 뷰마다·레이어마다 TLAS 버퍼·인스턴스 버퍼·scratch가 따로 있다. SBT 레이어는 Base/Decals 둘뿐이고, FarField는 Base의 레코드를 공유한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
인스턴스는 성격에 따라 둘로 갈린다. <strong>Cached 인스턴스</strong>는 프레임 간 영속하며 free list로 관리되고(정적 메시), <strong>Transient 인스턴스</strong>는 매 프레임 새로 수집된다(동적). 캐시드 인스턴스는 뷰별 가시성 비트(<code>MarkInstanceVisible</code>)로 어느 뷰에 보이는지만 갱신하면 되니, 매 프레임 전체를 다시 모으는 비용을 아낀다.
</p>

<p style="color:var(--text2);line-height:1.85;">
매 프레임 TLAS를 만드는 과정은 <strong>태스크 기반 파이프라인</strong>이다(5.8은 구버전의 단일 <code>GatherRayTracingWorldInstances</code> 함수를 걷어냈다). 순서는 이렇다.
</p>

<div class="code-block"><div class="code-lang">흐름 — RayTracing.cpp + DeferredShadingRenderer.cpp</div><span class="num">1.</span> GatherRelevantPrimitives   <span class="cm">// ParallelFor로 프리미티브 필터링(가시성·플래그·컬링)</span>
<span class="num">2.</span> FinishGatherInstances       <span class="cm">// static/dynamic/cached 인스턴스 수집 + auto-instancing</span>
<span class="num">3.</span> DispatchRayTracingWorldUpdates
     ├─ Nanite RT 스트리밍/빌드
     ├─ dynamic geometry CS 디폼 (05장)
     ├─ RayTracingScene.Update  <span class="cm">// GPU 인스턴스 컬링 + native desc 작성</span>
     └─ RayTracingScene.Build   <span class="cm">// 레이어×뷰 TLAS 빌드, BVHWrite→BVHRead</span></div>

<p style="color:var(--text2);line-height:1.85;">
2단계의 <strong>auto-instancing</strong>이 중요하다. 같은 지오메트리에 같은 mesh command 플래그를 가진 프리미티브들은 <code>InstancingKey()</code> 해시로 묶여 <strong>하나의 인스턴스로 배칭</strong>된다(<code>r.RayTracing.AutoInstance=1</code>). 숲의 나무 수천 그루가 인스턴스 하나로 접히는 식이다. 3단계 <code>Update</code>에서는 더 흥미로운 일이 벌어진다 — 인스턴스 디스크립터(변환 행렬 + BLAS 주소 + 마스크)를 <strong>CPU가 아니라 GPU에서</strong> 작성한다. <code>RayTracingBuildInstanceBufferCS</code>가 GPUScene의 변환을 읽어 native instance desc를 직접 써내고, 이때 <strong>인스턴스 컬링도 GPU에서</strong> 함께 처리한다. Nanite BLAS의 주소도 이 시점에 해결된다.
</p>

<div class="data-table">
<table>
<tr><th>CVar</th><th>기본</th><th>의미</th></tr>
<tr><td><code>r.RayTracing.Scene.BuildMode</code></td><td>1 (FastTrace)</td><td>TLAS는 매 프레임 <strong>재빌드</strong> (refit 아님)</td></tr>
<tr><td><code>r.RayTracing.Culling</code></td><td>3</td><td>거리 OR 각도 기반 컬링</td></tr>
<tr><td><code>r.RayTracing.Culling.Radius</code></td><td>30000 (300m)</td><td>이 거리 밖 인스턴스 컬</td></tr>
<tr><td><code>r.RayTracing.Culling.Angle</code></td><td>1.0°</td><td>화면상 각크기 이하 컬</td></tr>
<tr><td><code>r.RayTracing.AsyncBuild</code></td><td>(RHI 지원 시)</td><td>TLAS 빌드를 비동기 컴퓨트로</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
TLAS를 매 프레임 <strong>FastTrace로 재빌드</strong>하는 이 선택은 NVIDIA 모범 사례와 정확히 일치한다 — "TLAS는 <code>PREFER_FAST_TRACE</code>로 매 프레임 rebuild하라. refit의 이득이 트래버설 품질 손해를 정당화하지 못한다". TLAS는 인스턴스 수백~수천 개만 담아 상대적으로 가벼우니, 매번 최적 품질로 다시 짓는 게 남는 장사다. 단 Path Tracer는 컬링을 강제 해제한다 — 오프라인 품질엔 화면 밖 지오메트리도 다 필요하기 때문이다. 프레임 끝(<code>EndFrame</code>)에는 transient 인스턴스를 리셋하고 미사용 TLAS 버퍼를 해제한다.
</p>

<div class="callout callout-info">
<div class="callout-title">Tracing feedback — 09장 보충</div>
<p><code>r.RayTracing.Scene.UseTracingFeedback</code>를 켜면, 셰이더가 실제로 히트한 인스턴스를 UAV에 기록한다(<code>RayTracingFeedback.usf</code>). 다음 프레임엔 이 목록을 참고해 "정말 광선이 맞는" 동적 지오메트리만 갱신한다(08장). 렌더러가 자기 트레이싱 결과를 되먹여 다음 프레임의 빌드 작업을 줄이는 피드백 루프다. inline 트레이싱 전용이다.</p>
</div>

<span class="section-eyebrow">10 — SBT / hit group</span>
</div>

# SBT: 광선을 올바른 셰이더에 꽂는 인덱스 산수

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
DXR에서 가장 악명 높은 부분이 <strong>SBT(Shader Binding Table)</strong>다. SBT는 셰이더 레코드의 배열인데, 각 레코드는 <strong>32바이트 셰이더 식별자 + 로컬 루트 인수</strong>로 이뤄진다(DXR 스펙: 시작 주소 64바이트 정렬, stride 32바이트 배수, 최대 4096바이트). 광선이 어떤 hit group을 실행할지는 <strong>여러 곳에서 준 오프셋의 합</strong>으로 정해진다.
</p>

<div class="formula">hitGroupRecordIndex =
    InstanceContributionToHitGroupIndex        // TLAS 인스턴스 desc에 기록
  + GeometryIndex × MultiplierForGeometryContribution   // = NUM_SHADER_SLOTS
  + RayContributionToHitGroupIndex             // TraceRay 인수 (레이 종류)</div>

<p style="color:var(--text2);line-height:1.85;">
이 세 항의 합이 정확히 맞아떨어져야 광선이 올바른 머티리얼 셰이더로 간다. 하나라도 어긋나면 엉뚱한 셰이더가 실행되거나 GPU가 크래시한다. 언리얼은 이 산수를 <strong>자기 SBT 할당자로 관리한다</strong>. 설계의 출발점은 <code>RayTracingDefinitions.h</code>의 슬롯 배치다 — <strong>세그먼트 하나당 레코드 2개</strong>를 둔다.
</p>

<div class="data-table">
<table>
<tr><th>슬롯</th><th>값</th><th>용도</th></tr>
<tr><td><code>RAY_TRACING_SHADER_SLOT_MATERIAL</code></td><td>0</td><td>풀 머티리얼 closest-hit (셰이딩)</td></tr>
<tr><td><code>RAY_TRACING_SHADER_SLOT_SHADOW</code></td><td>1</td><td>그림자 전용 — 불투명이면 값싼 <code>OpaqueShadowCHS</code></td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
그래서 <code>MultiplierForGeometryContribution = NUM_SHADER_SLOTS = 2</code>다. 세그먼트 0의 머티리얼 레코드가 인덱스 N에 있으면 그림자 레코드는 N+1, 세그먼트 1은 N+2·N+3에 있다. <code>TraceRay</code>가 <code>RayContribution</code>으로 0(머티리얼) 또는 1(그림자)을 주면 같은 세그먼트의 두 레코드 중 하나를 고른다. 여기에 <strong>miss 슬롯 2개</strong>(<code>DEFAULT=0</code>, <code>LIGHTING=1</code>)와 <strong>8비트 인스턴스 마스크</strong>가 더해진다 — <code>OPAQUE=0x01</code>, <code>TRANSLUCENT=0x02</code>, <code>OPAQUE_SHADOW=0x04</code>, <code>HAIR_STRANDS=0x40</code>, <code>FarField=0x80</code> 등으로, <code>TraceRay</code>의 <code>InstanceInclusionMask</code>가 레이 종류별로 인스턴스를 필터링한다. 그림자 레이가 반투명만 골라 맞거나, Lumen이 FarField만 트레이스하는 게 이 마스크로 된다.
</p>

<div class="callout callout-purple">
<div class="callout-title">재귀 깊이 = 1</div>
<p>언리얼의 <code>RAY_TRACING_MAX_ALLOWED_RECURSION_DEPTH</code>는 <strong>1</strong>이다. hit 셰이더 안에서 또 <code>TraceRay</code>를 부르는 재귀를 쓰지 않는다는 뜻이다. 대신 raygen이 루프를 돌며 반사·바운스를 <strong>반복(iteration)</strong>으로 푼다. 재귀는 스택 메모리를 잡아먹고 하드웨어마다 한계가 다르니, 루프로 펴는 편이 성능·이식성 모두 유리하다. Path Tracer의 wavefront 구조(13장의 Path Tracer)가 이 철학의 극단이다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
할당은 <code>RayTracingShaderBindingTable.cpp</code>의 <code>FRayTracingSBTAllocation</code>이 맡는다. 정적 범위(<code>AllocateStaticRange</code>)는 {Geometry, Flags, SegmentCount}를 키로 <strong>dedup(refcount)</strong>해서 같은 지오메트리는 레코드를 공유하고, 동적 범위는 정적 최대치 뒤에서 bump-alloc하며 매 프레임 리셋된다. 그리고 <strong>persistent SBT</strong>(<code>r.RayTracing.PersistentSBT=1</code>)를 켜면 SBT를 프레임 간 유지하고 <strong>더러워진(dirty) 레코드만 다시 기록</strong>한다 — 크기가 부족해지면 2배로 확장하며 전체를 dirty로 표시한다. 미지원 환경에서는 매 프레임 transient SBT를 새로 만든다. 바인딩 제출도 병렬이다 — <code>FRayTracingLocalShaderBindingWriter</code>가 태스크당 1024개씩 수집해 merge한 뒤 <code>CommitShaderBindingTable</code>로 커밋한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
머티리얼 hit group 자체는 <strong>템플릿 퍼뮤테이션</strong>이다 — <code>TMaterialCHS&lt;라이트맵정책, AnyHit여부, Intersection여부, RayConeTexLOD여부&gt;</code>. 엔트리 문자열이 스테이지를 결합한다: <code>"closesthit=MaterialCHS anyhit=MaterialAHS"</code> 같은 문자열이 <code>SF_RayHitGroup</code> 하나로 컴파일된다. any-hit이 붙느냐는 블렌드 모드가 정한다 — <code>RTNeedsAnyHitShader(BlendMode)</code>가 Masked/Translucent/Modulate/AlphaComposite면 참(any-hit 셰이더 — 이하 AHS — 필요), Opaque/Additive면 거짓이다. 이건 NVIDIA가 "<strong>any-hit은 트래버설을 중단시키므로 비싸다, 최소화하라</strong>"고 경고한 그 지점이다 — 언리얼은 불투명 지오메트리에서 AHS를 아예 빼(05장의 <code>bForceOpaque</code>) 트래버설이 끊기지 않게 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
파이프라인 생성(<code>CreateMaterialRayTracingMaterialPipeline</code>)은 raygen 약 120개 + miss 라이브러리 + hit group 라이브러리(+필수 <code>OpaqueShadow</code>/<code>HiddenMaterial</code>)를 묶는다. 무거운 작업이라 <strong>논블로킹 비동기 생성</strong>(<code>r.RayTracing.NonBlockingPipelineCreation=1</code>)을 지원한다 — PSO가 아직 준비 안 됐으면 지난 프레임의 fallback PSO를 쓰고 넘어간다. RT 파이프라인 컴파일로 프레임이 멈추는 것을 막는, 06장의 빌드 예산과 같은 목적의 장치다.
</p>

<span class="section-eyebrow">11 — 셰이더 코드</span>
</div>

# 셰이더: 하나의 소스, 두 개의 경로, 64바이트의 payload

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
셰이더 레벨로 내려가면 언리얼의 영리함이 매크로에서 드러난다. <code>RayTracingCommon.ush</code>의 <code>RAY_TRACING_ENTRY_*</code> 매크로가 DXR의 <code>[shader("raygeneration")]</code> 같은 애트리뷰트로 전개되는데, 백미는 <strong><code>RAY_TRACING_ENTRY_RAYGEN_OR_INLINE</code></strong>이다. 이 매크로 하나가 <strong>같은 소스에서 두 개의 엔트리를 생성</strong>한다 — inline RayQuery용 컴퓨트 셰이더(<code>nameCS</code>)와 정통 raygen 셰이더(<code>nameRGS</code>). 하드웨어가 RayGen 셰이더를 지원하면 RGS를, 지원 안 하고 inline만 되면 CS를 쓴다. 그림자와 Lumen이 이 매크로로 <strong>단일 소스에서 이중 경로</strong>를 유지한다.
</p>

<div class="code-block"><div class="code-lang">HLSL — 개념: 하나의 소스가 두 엔트리로</div><span class="cm">// 이 한 줄이 OcclusionRGS(raygen)와 OcclusionCS(inline) 둘 다 생성</span>
<span class="fn">RAY_TRACING_ENTRY_RAYGEN_OR_INLINE</span>(Occlusion)
{
    <span class="ty">FRayDesc</span> Ray = <span class="fn">CreateShadowRay</span>(...);
    <span class="ty">FMinimalPayload</span> Payload = <span class="fn">TraceVisibilityRay</span>(TLAS, Ray);
    Output[PixelCoord] = Payload.<span class="fn">IsHit</span>() ? <span class="num">0</span> : <span class="num">1</span>;   <span class="cm">// 가려짐/안 가려짐</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>payload</strong>는 raygen과 hit/miss 셰이더가 주고받는 inout 구조체인데, 그 크기가 곧 레지스터 압박이라 언리얼은 여기 공을 들인다. 계층은 이렇다. 가장 가벼운 <code>FMinimalPayload</code>는 <code>float HitT</code> 하나뿐이다(miss면 <code>HitT=-1</code>) — 그림자 레이는 "맞았나 안 맞았나"만 알면 되므로 이걸 쓴다. 반대편 극단이 레거시 GBuffer 경로의 <strong><code>FPackedMaterialClosestHitPayload</code></strong>로, radiance·normal·baseColor·metallic·roughness·IOR·ShadingModelID를 fp16으로 비트 패킹해 <strong>정확히 64바이트</strong>에 욱여넣는다. Substrate 경로면 28바이트 고정 + 런타임 계산 데이터로 더 줄인다.
</p>

<div class="data-table">
<table>
<tr><th>payload</th><th>크기</th><th>쓰는 곳</th></tr>
<tr><td><code>FMinimalPayload</code></td><td>4B (HitT)</td><td>그림자 가시성 레이</td></tr>
<tr><td><code>FDefaultPayload</code></td><td>~24B</td><td>barycentrics·InstanceID 등 기본</td></tr>
<tr><td><code>FLumenMinimalPayload</code></td><td>~12B (HitT+패킹)</td><td>Lumen/MegaLights (surface cache 조회)</td></tr>
<tr><td><code>FPackedMaterialClosestHitPayload</code></td><td>64B</td><td>레거시 GBuffer 풀 머티리얼</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
payload 타입은 C++ 셰이더 클래스가 <code>GetRayTracingPayloadType()</code>으로 선언하면, 컴파일 시 <code>RT_PAYLOAD_TYPE</code>·<code>RT_PAYLOAD_MAX_SIZE</code> define이 주입되고 <code>CHECK_RT_PAYLOAD_SIZE</code> static assert이 크기를 검증한다. 파이프라인 생성 시 <code>MaxPayloadSizeInBytes</code>로 전달돼 하드웨어가 레지스터를 예약한다. 비트를 아끼려 <strong>입력 플래그와 출력 플래그가 같은 비트를 재사용</strong>하기도 한다 — <code>SHADOW_RAY</code>·<code>CAMERA_RAY</code> 같은 입력 플래그와 <code>FRONT_FACE</code> 같은 출력 플래그가 동시에 존재하지 않으니 비트를 겹쳐 쓴다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<code>TraceRay</code>는 목적별 래퍼로 감싸져 있다. <code>TraceVisibilityRay</code>는 그림자용으로 <code>ACCEPT_FIRST_HIT_AND_END_SEARCH | SKIP_CLOSEST_HIT_SHADER</code> 플래그를 달고 SBT 슬롯 <code>SHADOW</code>, minimal payload를 쓴다 — 컴퓨트 셰이더에서 호출되면 자동으로 <code>TraceRayInline</code> 경로로 간다. <code>TraceMaterialRay</code>는 슬롯 <code>MATERIAL</code>에 ray cone(텍스처 LOD)까지 실어 보내고 패킹/언패킹을 자동 처리한다.
</p>

<div class="callout callout-info">
<div class="callout-title">ACCEPT_FIRST_HIT — 그림자 레이의 정석</div>
<p>그림자는 "광원까지 가는 길에 <strong>뭐라도 하나 막고 있나</strong>"만 알면 된다. 가장 가까운 교차를 찾을 필요가 없다 — 아무거나 하나 맞으면 즉시 "가려짐"이다. <code>RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH</code>가 바로 그 최적화로, 첫 교차에서 트래버설을 끝낸다. NVIDIA 모범 사례가 "가능하면 첫 히트에서 광선을 종료하라"고 콕 집은 그 플래그이며, 언리얼의 <code>TraceVisibilityRay</code>가 이걸 기본으로 단다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
hit 셰이더 안에서 지오메트리에 접근하려면 로컬 루트 시그니처로 바인딩된 인덱스/정점 버퍼가 필요하다. <code>LoadTriangleBaseAttributes(PrimitiveId)</code>가 16/32비트/논인덱스를 분기해 정점 3개를 로드하고, <code>CalcInterpolants</code>가 버텍스 팩토리 인터폴런트를 barycentric으로 보간하며 <strong>ray cone 기반 텍스처 LOD</strong>까지 계산한다. 머티리얼 CHS는 생성된 <code>Material.ush</code>를 include해 머티리얼 그래프를 평가하고 payload를 패킹한다 — 단, 그림자 레이이면서 불투명이면 조기 리턴한다(minimal 모드). AHS는 Masked면 <code>GetMaterialMask()&lt;0 → IgnoreHit()</code>, 반투명 그림자면 <code>ShadowVisibility *= Transparency</code>로 fractional visibility를 누적하며 <code>IgnoreHit()</code>를 반복한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
마지막으로 <strong>deferred materials</strong>라는 코히런시 최적화가 있다. 1차 트레이스에서는 셰이딩을 하지 않고 <strong>SortKey(=hit group UserData)만</strong> 수집한 뒤, 픽셀을 머티리얼별로 정렬하고, 2차 트레이스에서 정렬된 순서로 셰이딩한다. 인접 스레드가 같은 머티리얼 셰이더를 실행하게 만들어 divergence를 줄이는 것이다(AMD는 hit token으로 재트래버설까지 스킵한다). 컴파일은 DXC로 <code>lib_6_6</code>/<code>lib_6_8</code> 타깃, 프리퀀시는 <code>SF_RayGen=6</code>·<code>SF_RayMiss=7</code>·<code>SF_RayHitGroup=8</code>·<code>SF_RayCallable=9</code>다.
</p>

<span class="section-eyebrow">12 — 프레임 순서</span>
</div>

# 한 프레임에 이 모든 것이 도는 순서

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
지금까지의 조각들을 시간순으로 꿰면 non-path-tracing 프레임의 RT 파이프라인이 된다. 06장의 빌드 예산, 08장의 동적 디폼, 09장의 TLAS 만들기, 10장의 SBT 바인딩이 이 순서 위에 얹힌다.
</p>

<div class="code-block"><div class="code-lang">프레임 순서 (non-path-tracing)</div>GatherRelevantPrimitives (태스크)
  → FinishGatherInstances        <span class="cm">// static/dynamic/cached + auto-instancing</span>
  → ProcessBuildRequests         <span class="cm">// BLAS 예산 빌드 (06장) + Nanite RT 빌드</span>
  → dynamic geometry CS 디폼      <span class="cm">// 스키닝/WPO → BLAS refit/rebuild (08장)</span>
  → RayTracingScene.Update       <span class="cm">// GPU 인스턴스 컬링 + native desc (09장)</span>
  → RayTracingScene.Build        <span class="cm">// 레이어×뷰 TLAS 빌드, BVHWrite→BVHRead</span>
  → RT 파이프라인 생성(비동기) + SBT 할당/dirty 바인딩 (10장)
  → miss/라이트펑션/callable 바인딩 → CommitShaderBindingTable
  → 각 RT 이펙트 패스              <span class="cm">// RayTraceDispatch / inline CS (13장)</span>
  → PostRender(feedback/stats) → EndFrame(리셋)</div>

<p style="color:var(--text2);line-height:1.85;">
눈여겨볼 것은 <strong>빌드(BLAS·TLAS)와 셰이딩(이펙트 패스)이 분리</strong>돼 있다는 점이다. 프레임 전반부는 "이번 프레임에 트레이스 가능한 씬을 준비"하는 데 쓰이고 — 예산 안에서 BLAS를 빌드하고, 동적 지오메트리를 디폼하고, TLAS를 만들고, SBT를 엮고 — 후반부에 비로소 각 이펙트가 그 위에 광선을 쏜다. 준비된 이 <strong>한 벌의 인프라</strong>를 여러 이펙트가 공유하는 것이 다음 장의 주제다.
</p>

<span class="section-eyebrow">13 — 활용처</span>
</div>

# 한 벌의 인프라를 나눠 쓰는 네 시스템

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
지금까지 만든 BLAS·TLAS·SBT·payload는 특정 효과 전용이 아니다. Ray Traced Shadows, Lumen, MegaLights, Path Tracer가 모두 이 <strong>공유 인프라</strong> 위에서 돌며, 각자 필요한 만큼만 골라 쓴다. 어떻게 나눠 쓰는지가 언리얼 RT 설계의 완성이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>① Ray Traced Shadows.</strong> <code>r.RayTracing.Shadows</code>는 <strong>기본 0</strong>(래스터 섀도우맵이 디폴트)이고, 라이트별로 <code>ECastRayTracedShadow</code>로 켠다. 하드웨어가 RayGen을 지원하면 <code>FOcclusionRGS</code>, 아니고 inline만 되면 <code>FOcclusionCS</code>로 폴백한다 — 11장에서 본 <code>RAY_TRACING_ENTRY_RAYGEN_OR_INLINE(Occlusion)</code> 단일 소스가 이 둘을 만든다. <code>TraceVisibilityRay</code>(ACCEPT_FIRST_HIT)로 minimal payload만 주고받고, 결과는 penumbra+거리 3레이아웃으로 디노이저에 넘어간다. 자세한 소프트 섀도우·디노이징은 <a href="/raytracing-shadow">Ray Traced Shadows 글</a>에서 다뤘다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>② Lumen HWRT.</strong> Lumen의 하드웨어 레이 트레이싱(<code>r.Lumen.HardwareRayTracing=1</code>)은 payload를 <strong>이원화</strong>하는 게 핵심이다. 풀 머티리얼(64B) 대신 <strong><code>FLumenMinimalPayload</code></strong>(HitT + 12B: 머티리얼 인덱스·노멀·GPUScene 인스턴스 인덱스)를 쓴다 — 히트 지점의 라이팅을 머티리얼 평가가 아니라 <strong>surface cache 샘플링</strong>으로 해결하므로 무거운 머티리얼 payload가 필요 없다. 그래서 뷰마다 <strong>SBT/PSO를 2세트</strong> 둔다: <code>View.MaterialRayTracingData</code>(풀 머티리얼 — 그림자·패스트레이서·hit lighting)와 <code>View.LumenRayTracingData</code>(minimal — Lumen·MegaLights). 모드는 <code>LightingMode</code> 0(SurfaceCache)/1(HitLighting)/2(HitLightingForReflections)로 나뉘고, hit lighting 모드는 RGS 필수, surface cache 모드는 inline으로 돈다. 09장에서 본 <strong>FarField TLAS 레이어</strong>가 여기서 원거리 재트레이스에 쓰인다. Lumen 전반은 <a href="/lumen">Lumen 글</a> 참고.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>③ MegaLights.</strong> MegaLights는 그림자 레이를 위해 <strong>Lumen HWRT 인프라를 통째로 재사용</strong>한다. <code>MegaLightsHardwareRayTracing.usf</code>가 <code>LumenHardwareRayTracingCommon.ush</code>를 include하고 <code>TraceLumenMinimalRay(TLAS, FarFieldTLAS, ...)</code>를 호출한다 — 즉 Lumen의 minimal payload와 SBT를 그대로 쓴다. 기본 inline RayQuery(<code>r.MegaLights.HardwareRayTracing.Inline=1</code>)이고, 알파 마스크 평가는 <code>EvaluateMaterialMode</code>(0=off/1=AHS/2=retrace)로 조절한다. 반투명 표면 라이팅 확장은 <a href="/megalights">MegaLights 글</a>에서 다뤘다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>④ Path Tracer.</strong> 오프라인 품질을 노리는 Path Tracer(<code>PathTracingMainRG</code>)는 <strong>wavefront 구조</strong>가 특징이다. CAMERA/INNER/TAIL 세 커널 퍼뮤테이션으로 나눠, path state를 <code>StructuredBuffer</code>에 압축 저장하고 활성 경로만 <code>RayTraceDispatchIndirect</code>로 바운스마다 재디스패치한다 — 10장에서 본 "재귀 대신 반복" 철학의 극단이다. NEE(광원 CDF + light grid)로 직접광을 샘플링하고, SER(<code>NvReorderThread</code>, <code>PATH_TRACER_USE_SER</code>)로 셰이더 실행을 재정렬하며, 프레임 간 radiance를 누적한다(BLAS 재빌드가 감지되면 누적 무효화). 같은 <code>RayTracingScene</code>과 풀 머티리얼 SBT를 쓰되 payload는 <code>PathTracingMaterial</code>이고, 컬링은 강제 해제된다. 렌더링 방정식을 오프라인에 굽는 관점은 <a href="/gpu-lightmass">GPU Lightmass 글</a>과 이어진다.
</p>

<div class="data-table">
<table>
<tr><th>시스템</th><th>payload</th><th>주 경로</th><th>SBT 세트</th></tr>
<tr><td>Ray Traced Shadows</td><td><code>FMinimalPayload</code></td><td>RGS ↔ inline 폴백</td><td>Material(shadow 슬롯)</td></tr>
<tr><td>Lumen HWRT</td><td><code>FLumenMinimalPayload</code></td><td>inline(SC) / RGS(hit lighting)</td><td>Lumen + Material</td></tr>
<tr><td>MegaLights</td><td><code>FLumenMinimalPayload</code></td><td>inline (Lumen 재사용)</td><td>Lumen</td></tr>
<tr><td>Path Tracer</td><td><code>PathTracingMaterial</code></td><td>RGS wavefront</td><td>Material</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
표를 세로로 읽으면 언리얼 설계의 요점이 보인다 — <strong>payload를 가볍게 유지할 수 있는 시스템(그림자·Lumen·MegaLights)은 minimal payload로 인프라를 공유</strong>하고, 진짜 머티리얼 평가가 필요한 시스템(Path Tracer, Lumen hit lighting)만 풀 머티리얼 SBT/PSO를 별도로 든다. 광선을 쏘는 부품(BLAS·TLAS·TraceRay)은 한 벌이되, 그 위에서 payload와 SBT를 시스템별로 갈아 끼우는 것이다.
</p>

<span class="section-eyebrow">정리</span>
</div>

# 정리

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
언리얼의 레이 트레이싱을 한 문장으로 압축하면 — <strong>"하드웨어가 주는 BVH 빌드·TraceRay·hit group이라는 원시 부품 위에, 엔진이 '언제 빌드/refit/compaction할지'의 스케줄링과 '광선을 어떤 셰이더로 보낼지'의 SBT 라우팅, 그리고 '데이터를 몇 바이트에 담을지'의 payload 패킹을 얹어, 한 벌의 인프라를 Shadows·Lumen·MegaLights·Path Tracer가 나눠 쓰게 만든" 조율의 체계</strong>다. 언리얼은 BVH를 직접 만들지 않는다 — 만들어달라고 요청하는 시점과 방식을 관리할 뿐이다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">BLAS / TLAS</div>
<div class="card-title">한 번 빌드 vs 매 프레임 재빌드</div>
<div class="card-desc">정적 메시는 FastTrace+compaction으로 1회, TLAS는 매 프레임 FastTrace 재빌드. DXR·NVIDIA 권장을 코드로 옮긴 분업.</div>
</div>
<div class="card teal">
<div class="card-label">예산 · aging</div>
<div class="card-title">빌드를 시간축에 분산</div>
<div class="card-desc">BLAS 빌드는 우선순위 예산 큐로, +0.001/프레임 boost로 기아 방지. compaction은 리드백 때문에 멀티 프레임 비동기.</div>
</div>
<div class="card purple">
<div class="card-label">SBT 인덱싱</div>
<div class="card-title">Instance + Geometry×2 + Ray</div>
<div class="card-desc">세그먼트당 레코드 2개(material/shadow), 인스턴스 마스크 8비트, dedup·persistent SBT로 그 악명 높은 산수를 관리한다.</div>
</div>
<div class="card gold">
<div class="card-label">payload</div>
<div class="card-title">4B에서 64B까지</div>
<div class="card-desc">그림자는 HitT 하나, Lumen은 12B(surface cache), 레거시 머티리얼은 64B 비트 패킹. 크기가 곧 레지스터 압박.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
숫자로 다시 정리하면 — 세그먼트당 SBT 슬롯 2개, geometry multiplier 2, 재귀 깊이 1, compaction 문턱 128 프리미티브·배치 64, 컬링 반경 300m·각도 1°, payload 최대 64B, 인스턴스 버퍼 8192 단위·TLAS 버퍼 16MB 단위. 이 상수들 뒤에는 대부분 DXR 스펙의 제약이나 NVIDIA 모범 사례의 권고가 있다 — refit이 트래버설 품질을 갉아먹는다는 스펙 문장이 <code>ForceBuild</code> 카운터로, any-hit이 비싸다는 경고가 <code>bForceOpaque</code>로, "FAST_BUILD도 UPDATE도 없어야 최대 압축"이라는 팁이 <code>ShouldCompactAfterBuild</code> 조건으로 굳었다. 이 인프라 위에서 광선이 실제로 무슨 일을 하는지는 — 그림자를 쏘고(<a href="/raytracing-shadow">Ray Traced Shadows</a>), 간접광을 모으고(<a href="/lumen">Lumen</a>), 렌더링 방정식을 오프라인에 굽는(<a href="/gpu-lightmass">GPU Lightmass</a>) — 각 시스템의 이야기다.
</p>

<span class="section-eyebrow">참고</span>

<div class="card-grid" style="grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));">
<div class="card blue">
<div class="card-label">엔진 소스</div>
<div class="card-title">UE 5.8 Renderer / RHI</div>
<div class="card-desc"><code>D3D12RayTracing.cpp</code>, <code>RayTracingScene.{h,cpp}</code>, <code>RayTracingShaderBindingTable.cpp</code>, <code>RayTracingMaterialHitShaders.cpp</code>, <code>RayTracingGeometryManager.cpp</code>, <code>RayTracingCommon.ush</code>. 이 글의 모든 파일:라인·상수의 1차 출처.</div>
</div>
<div class="card purple">
<div class="card-label">DXR 스펙</div>
<div class="card-title">DirectX Raytracing Specification</div>
<div class="card-desc"><a href="https://microsoft.github.io/DirectX-Specs/d3d/Raytracing.html">microsoft.github.io/DirectX-Specs</a> — 2단계 AS, 셰이더 스테이지, hit group·SBT 레코드 레이아웃, update가 정점 위치만 바꾼다는 제약. (본문 클레임 직접 대조 확인)</div>
</div>
<div class="card teal">
<div class="card-label">NVIDIA 모범 사례</div>
<div class="card-title">RTX Ray Tracing Best Practices</div>
<div class="card-desc"><a href="https://developer.nvidia.com/blog/best-practices-using-nvidia-rtx-ray-tracing/">developer.nvidia.com/blog</a> — TLAS 매 프레임 rebuild, 정적 BLAS FAST_TRACE+compaction, refit 품질 저하와 주기적 rebuild, any-hit 최소화. (직접 대조 확인)</div>
</div>
<div class="card gold">
<div class="card-label">NVIDIA compaction</div>
<div class="card-title">Tips: Acceleration Structure Compaction</div>
<div class="card-desc"><a href="https://developer.nvidia.com/blog/tips-acceleration-structure-compaction/">developer.nvidia.com/blog</a> — 최소 50% 절감, EmitPostbuildInfo→리드백→COPY_MODE_COMPACT 멀티 프레임 절차, FAST_BUILD·UPDATE 없어야 최대 압축. (직접 대조 확인)</div>
</div>
</div>
</div>
