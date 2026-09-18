---
layout: post
title: "UE5 Hardware Ray Tracing Architecture: GPU가 Ray를 쏘는 순간 가장 빠르게 계산할 수 있도록, 게임 스레드에서 GPU까지 한 프레임 동안 데이터를 준비하는 과정"
icon: paper
permalink: raytracing-shader
categories: Rendering
tags: [ComputerGraphics, Rendering, UnrealEngine, RayTracing, DXR, BVH, AccelerationStructure, ShaderBindingTable, Lumen]
excerpt: "언리얼의 하드웨어 레이 트레이싱을 이론 순서가 아니라 한 프레임이 실제로 흐르는 순서로 읽는다. GPU가 Ray를 쏘는 순간 가장 빠르게 계산할 수 있도록 데이터를 준비하는 과정이다. 게임 스레드가 어떤 메시를 레이 트레이싱에 넣을지 표시하고, 렌더 스레드가 그 메시의 삼각형을 Ray가 빨리 찾을 수 있는 자료구조로 예산 안에서 미리 빌드하고, 워커 태스크가 이번 프레임에 Ray가 맞을 수 있는 물체를 골라내고, 렌더 스레드가 모양이 바뀐 메시의 갱신을 예약하고 씬 전체를 하나로 묶는 자료구조와 '맞으면 어느 셰이더를 실행할지' 적은 연결표를 준비하고, RHI 스레드가 그것을 D3D12 커맨드로 번역하고, GPU가 자료구조를 빌드하고 Ray를 쏘는 순서다. 각 단계에 필요한 개념(자료구조가 왜 트리이고 왜 두 층인지, 여섯 종류의 셰이더, 연결표의 줄 번호 계산, Ray가 들고 다니는 데이터의 크기)은 그 단계가 나올 때 정식 용어와 함께 소개한다. UE 5.8 소스(RayTracing.cpp · RayTracingDynamicGeometryUpdateManager · RayTracingScene · RayTracingShaderBindingTable · D3D12RayTracing.cpp · RayTracingCommon.ush)를 코드로 추적하고 DirectX 레이 트레이싱(DXR) 스펙과 NVIDIA 모범 사례와 대조한다. 마지막으로 Shadows·Lumen·MegaLights·Path Tracer가 이 공용 인프라를 어떻게 나눠 쓰는지 정리한다."
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
> - 레이 트레이싱을 켜면 게임 스레드·렌더 스레드·워커 태스크·RHI 스레드·GPU 각각에 어떤 일이 생기고, 한 프레임 안에서 어떤 순서로 도는지 한 장으로 잡고 싶은 분
> - 프로파일러에서 `RayTracing_FinishGatherInstances`, `RayTracingDynamicGeometry`, `BuildAccelerationStructure_BottomLevel` 같은 스코프를 봤는데 그게 어느 단계의 무엇인지 연결이 안 되는 분
> - Ray가 물체를 빨리 찾게 해 주는 자료구조를 왜 두 층으로 나누고, 왜 어떤 것은 한 번만 빌드하고 어떤 것은 매 프레임 다시 빌드하는지, 스키닝처럼 모양이 바뀌는 메시는 어떻게 갱신하는지 궁금한 분
> - Ray가 물체에 맞은 뒤 GPU가 어떤 셰이더를 실행할지 스스로 찾아내는 방법과, Ray 하나가 들고 다니는 데이터를 언리얼이 어떻게 아끼는지 보고 싶은 분
> - Ray Traced Shadows·Lumen·MegaLights·Path Tracer가 사실 같은 RT 인프라를 나눠 쓴다는 게 코드로 어떻게 드러나는지 알고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - 한 프레임의 RT 파이프라인이 다섯 실행 주체(게임 스레드·렌더 스레드·워커 태스크·RHI 스레드·GPU)를 어떤 순서로 지나는지 (00장의 그림과 표)
> - 게임 스레드가 넘기는 것: 어떤 메시를 레이 트레이싱에 넣을지 표시하는 플래그와 자료구조 설계도(`FRayTracingGeometryInitializer`), 그리고 그 자료구조가 왜 트리이고 왜 두 층인가 (01장)
> - 렌더 스레드가 자료구조 빌드를 매 프레임 예산(`MaxBuiltPrimitivesPerFrame`) 안에서 나눠 처리하는 큐, 오래 기다린 요청을 앞으로 당기는 장치, 안 쓰는 것을 메모리에서 내리는 규칙 (02장)
> - 워커 태스크가 Ray가 맞을 수 있는 물체를 골라내는 과정(`GatherRelevantPrimitives`)과 여러 스레드가 나눠 모으는 방식, 그리고 엔진에서 유일하게 병렬 수집을 못 하는 프록시 (03장)
> - `FinishGatherInstances`가 하는 일: 렌더 스레드가 직접 모아야 하는 물체, 모양이 바뀐 메시를 조금만 고칠지 다시 빌드할지 정하는 기준, 같은 메시를 쓰는 물체를 하나로 묶는 처리 (04장)
> - `DispatchRayTracingWorldUpdates`가 등록하는 GPU 작업: 바뀐 정점 다시 계산, 씬 전체를 하나로 묶는 상위 자료구조를 GPU에서 매 프레임 다시 빌드하는 과정 (05장)
> - `SetupRayTracingRenderingData`가 셰이더들을 파이프라인 하나로 묶고, Ray가 맞은 물체에서 실행할 셰이더를 GPU가 찾아가는 연결표를 만드는 방법과 그 줄 번호 계산식 (06장)
> - RHI 스레드에서 D3D12 빌드 옵션과 버퍼 크기가 정해지는 자리, 그리고 크게 잡아둔 메모리를 여러 프레임에 걸쳐 회수하는 절차 (07장)
> - GPU에서 Ray 하나가 쏘아진 뒤 도는 여섯 종류의 셰이더, 두 층을 지나는 순회, NVIDIA·AMD·Intel 하드웨어의 차이, Ray가 들고 다니는 데이터의 크기와 한 소스로 두 경로를 만드는 매크로 (08·09장)
> - Shadows·Lumen HWRT·MegaLights·Path Tracer가 이 인프라를 어떻게 나눠 쓰는지 한눈에 보는 표 (11장)

<br>

{% include research-post-style.html %}

<div class="research-post">
<span class="section-eyebrow">00. 개요</span>
</div>

# 개요: 이 글은 이론 순서가 아니라 프레임이 흐르는 순서로 읽는다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
GPU에 레이 트레이싱 전용 유닛이 들어가면서 렌더링 엔지니어의 일이 하나 줄었다고 생각하기 쉽다. "Ray를 쏘고 부딪히는 삼각형을 찾는" 그 무식하게 비싼 계산을 이제 하드웨어가 대신 해주니까. 맞는 말이지만, 하드웨어가 해주는 것은 정확히 거기까지다. <strong>Ray 하나를 빨리 쏘는 능력</strong>뿐이다. 그 능력을 실제 게임 화면으로 만들기까지는 아직 할 일이 한참 남아 있다. 씬의 삼각형을 검색하기 좋은 자료구조로 미리 정리해 두되 매 프레임 전부 다시 만들지는 않도록 어떤 것은 한 번만, 어떤 것은 변형된 만큼만, 어떤 것은 바쁘면 다음 프레임으로 미루는 일. 크게 잡아둔 메모리를 틈틈이 회수하는 일. Ray가 무언가에 맞았을 때 그 물체의 머티리얼 셰이더가 정확히 실행되도록 연결표를 관리하는 일. Ray 하나하나가 들고 다니는 데이터를 바이트 단위로 아끼는 일. 하나같이 하드웨어가 안 해주는, 엔진 프로그래머의 역할이 아닐까 싶다.
</p>
<p style="color:var(--text2);line-height:1.85;">
이 글은 그 엔진의 일을 <strong>한 프레임이 실제로 흐르는 순서</strong>로 따라간다. 언리얼의 레이 트레이싱은 게임 스레드, 렌더 스레드, 워커 태스크, RHI 스레드<span class="fn-note"><input type="checkbox" id="fn-rhi" class="fn-toggle"><label for="fn-rhi" class="fn-ref">1</label><span class="fn-body"><strong>RHI(Render Hardware Interface):</strong> D3D12·Vulkan 같은 그래픽 API를 감싼 언리얼의 추상화 계층. 렌더 스레드는 RHI 커맨드를 기록만 하고, RHI 스레드가 그것을 실제 API 호출로 번역한다.</span></span>, GPU라는 다섯 실행 주체를 차례로 지나는데, 프로파일러에 잡히는 스코프도 이 순서로 나타나고, 비용이 튀는 자리도 이 순서 위의 어딘가다. 그래서 Ray 검색용 자료구조나 셰이더 연결표 같은 개념은 앞에서 따로 설명하지 않고, <strong>그 개념이 처음 필요해지는 단계에서 정식 이름과 함께 소개한다</strong>. 아래 그림이 이 글의 목차다. 위에서 아래로 시간이 흐르고, 상자에 적힌 번호가 장 번호다.
</p>
<div class="scene-fig">
<svg viewBox="0 0 648 452" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace">
<defs>
<marker id="rtx-lane-GT" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#414455"/></marker>
<marker id="rtx-lane-RT" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4338ca"/></marker>
<marker id="rtx-lane-WK" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0a8f72"/></marker>
<marker id="rtx-lane-RHI" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#b07d00"/></marker>
<marker id="rtx-lane-GPU" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d6304a"/></marker>
<marker id="rtx-lane-back" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7e8295"/></marker>
</defs>
<rect x="2" y="4" width="128" height="440" fill="rgba(123,130,150,0.05)"/>
<text x="66" y="20" fill="#414455" font-size="11" font-weight="600" text-anchor="middle">Game Thread</text>
<rect x="130" y="4" width="128" height="440" fill="rgba(123,130,150,0.02)"/>
<text x="194" y="20" fill="#4338ca" font-size="11" font-weight="600" text-anchor="middle">Render Thread</text>
<rect x="258" y="4" width="128" height="440" fill="rgba(123,130,150,0.05)"/>
<text x="322" y="20" fill="#0a8f72" font-size="11" font-weight="600" text-anchor="middle">Worker Tasks</text>
<rect x="386" y="4" width="128" height="440" fill="rgba(123,130,150,0.02)"/>
<text x="450" y="20" fill="#b07d00" font-size="11" font-weight="600" text-anchor="middle">RHI Thread</text>
<rect x="514" y="4" width="128" height="440" fill="rgba(123,130,150,0.05)"/>
<text x="578" y="20" fill="#d6304a" font-size="11" font-weight="600" text-anchor="middle">GPU</text>
<rect x="5" y="34" width="122" height="30" rx="4" fill="rgba(65,68,85,0.08)" stroke="#414455" stroke-width="1.4"/>
<text x="66" y="46" fill="#414455" font-size="8.2" text-anchor="middle">CreateSceneProxy</text>
<text x="66" y="58" fill="#7e8295" font-size="8.4" text-anchor="middle">RT 대상 메시 표시·설계도</text>
<text x="125" y="31" fill="#414455" font-size="8" text-anchor="end">01장</text>
<rect x="133" y="74" width="122" height="30" rx="4" fill="rgba(67,56,202,0.08)" stroke="#4338ca" stroke-width="1.4"/>
<text x="194" y="86" fill="#4338ca" font-size="8.2" text-anchor="middle">GeometryManager Tick</text>
<text x="194" y="98" fill="#7e8295" font-size="8.4" text-anchor="middle">메시 검색 자료구조 빌드</text>
<text x="253" y="71" fill="#4338ca" font-size="8" text-anchor="end">02장</text>
<rect x="261" y="114" width="122" height="30" rx="4" fill="rgba(10,143,114,0.08)" stroke="#0a8f72" stroke-width="1.4"/>
<text x="322" y="126" fill="#0a8f72" font-size="8.2" text-anchor="middle">GatherRelevantPrimitives</text>
<text x="322" y="138" fill="#7e8295" font-size="8.4" text-anchor="middle">동적 물체 병렬 수집</text>
<text x="381" y="111" fill="#0a8f72" font-size="8" text-anchor="end">03장</text>
<rect x="133" y="154" width="122" height="30" rx="4" fill="rgba(67,56,202,0.08)" stroke="#4338ca" stroke-width="1.4"/>
<text x="194" y="166" fill="#4338ca" font-size="8.2" text-anchor="middle">FinishGatherInstances</text>
<text x="194" y="178" fill="#7e8295" font-size="8.4" text-anchor="middle">확정·ScheduleUpdates</text>
<text x="253" y="151" fill="#4338ca" font-size="8" text-anchor="end">04장</text>
<rect x="261" y="194" width="122" height="30" rx="4" fill="rgba(10,143,114,0.08)" stroke="#0a8f72" stroke-width="1.4"/>
<text x="322" y="206" fill="#0a8f72" font-size="8.2" text-anchor="middle">AddInstances 태스크</text>
<text x="322" y="218" fill="#7e8295" font-size="8.4" text-anchor="middle">씬 목록·연결표 자리</text>
<text x="381" y="191" fill="#0a8f72" font-size="8" text-anchor="end">04장</text>
<rect x="133" y="234" width="122" height="30" rx="4" fill="rgba(67,56,202,0.08)" stroke="#4338ca" stroke-width="1.4"/>
<text x="194" y="246" fill="#4338ca" font-size="8.2" text-anchor="middle">DispatchRTWorldUpdates</text>
<text x="194" y="258" fill="#7e8295" font-size="8.4" text-anchor="middle">씬 전체 자료구조 빌드</text>
<text x="253" y="231" fill="#4338ca" font-size="8" text-anchor="end">05장</text>
<rect x="133" y="274" width="122" height="30" rx="4" fill="rgba(67,56,202,0.08)" stroke="#4338ca" stroke-width="1.4"/>
<text x="194" y="286" fill="#4338ca" font-size="8.2" text-anchor="middle">SetupRTRenderingData</text>
<text x="194" y="298" fill="#7e8295" font-size="8.4" text-anchor="middle">셰이더 파이프라인·연결표</text>
<text x="253" y="271" fill="#4338ca" font-size="8" text-anchor="end">06장</text>
<rect x="389" y="314" width="122" height="30" rx="4" fill="rgba(176,125,0,0.08)" stroke="#b07d00" stroke-width="1.4"/>
<text x="450" y="326" fill="#b07d00" font-size="8.2" text-anchor="middle">RHI_Translate</text>
<text x="450" y="338" fill="#7e8295" font-size="8.4" text-anchor="middle">빌드·DispatchRays 기록</text>
<text x="509" y="311" fill="#b07d00" font-size="8" text-anchor="end">07장</text>
<rect x="517" y="354" width="122" height="30" rx="4" fill="rgba(214,48,74,0.08)" stroke="#d6304a" stroke-width="1.4"/>
<text x="578" y="366" fill="#d6304a" font-size="8.2" text-anchor="middle">정점 갱신→자료구조 빌드</text>
<text x="578" y="378" fill="#7e8295" font-size="8.4" text-anchor="middle">Ray 발사: 여섯 종류 셰이더</text>
<text x="637" y="351" fill="#d6304a" font-size="8" text-anchor="end">08·09장</text>
<rect x="517" y="394" width="122" height="30" rx="4" fill="rgba(214,48,74,0.08)" stroke="#d6304a" stroke-width="1.4"/>
<text x="578" y="406" fill="#d6304a" font-size="8.2" text-anchor="middle">사용 기록·크기 리드백</text>
<text x="578" y="418" fill="#7e8295" font-size="8.4" text-anchor="middle">EndFrame → 다음 프레임</text>
<text x="637" y="391" fill="#d6304a" font-size="8" text-anchor="end">10장</text>
<line x1="66" y1="64" x2="194" y2="74" stroke="#4338ca" stroke-width="1.4" marker-end="url(#rtx-lane-RT)"/>
<line x1="194" y1="104" x2="322" y2="114" stroke="#0a8f72" stroke-width="1.4" marker-end="url(#rtx-lane-WK)"/>
<line x1="322" y1="144" x2="194" y2="154" stroke="#4338ca" stroke-width="1.4" marker-end="url(#rtx-lane-RT)"/>
<line x1="194" y1="184" x2="322" y2="194" stroke="#0a8f72" stroke-width="1.4" marker-end="url(#rtx-lane-WK)"/>
<line x1="322" y1="224" x2="194" y2="234" stroke="#4338ca" stroke-width="1.4" marker-end="url(#rtx-lane-RT)"/>
<line x1="194" y1="264" x2="194" y2="274" stroke="#4338ca" stroke-width="1.4" marker-end="url(#rtx-lane-RT)"/>
<line x1="194" y1="304" x2="450" y2="314" stroke="#b07d00" stroke-width="1.4" marker-end="url(#rtx-lane-RHI)"/>
<line x1="450" y1="344" x2="578" y2="354" stroke="#d6304a" stroke-width="1.4" marker-end="url(#rtx-lane-GPU)"/>
<line x1="578" y1="384" x2="578" y2="394" stroke="#d6304a" stroke-width="1.4" marker-end="url(#rtx-lane-GPU)"/>
<line x1="383" y1="224" x2="255" y2="278" stroke="#0a8f72" stroke-width="1" stroke-dasharray="4 3" marker-end="url(#rtx-lane-WK)"/>
<text x="328" y="262" fill="#0a8f72" font-size="8" text-anchor="middle">완료 대기</text>
<line x1="517" y1="409" x2="127" y2="409" stroke="#7e8295" stroke-width="1.2" stroke-dasharray="5 4" marker-end="url(#rtx-lane-back)"/>
<text x="322" y="403" fill="#7e8295" font-size="8.4" text-anchor="middle">다음 프레임의 02·04장으로 되먹임</text>
</svg>
<div class="scene-cap">한 프레임의 하드웨어 레이 트레이싱 파이프라인을 실행 주체별로 놓은 것이다. 위에서 아래로 시간이 흐르고, 상자의 번호가 이 글의 장 번호다. 렌더 스레드는 워커 태스크가 모은 후보를 FinishGatherInstances에서 확정하고, 물체 목록 태스크의 완료는 SetupRayTracingRenderingData에서 기다린다. RHI 스레드와 GPU는 렌더 스레드가 등록만 해 둔 패스를 실제로 실행하는 쪽이다.</div>
</div>
<p style="color:var(--text2);line-height:1.85;">
그림을 표로 다시 적으면 이렇다. 프로파일러에서 어떤 스코프를 들고 왔다면 셋째 열에서 찾아 해당 장으로 바로 가면 된다.
</p>
<div class="data-table">
<table>
<tr><th>#</th><th>실행 주체</th><th>일어나는 일</th><th>함수 · 프로파일러 스코프</th><th>장</th></tr>
<tr><td>1</td><td>게임 스레드</td><td>컴포넌트가 프록시를 만들면서 "이 메시는 레이 트레이싱에 넣는다"고 표시한다. 함께 그 메시의 정점·인덱스 버퍼로 Ray 검색용 자료구조를 어떻게 빌드할지 적은 설계도를 넘긴다</td><td><code>CreateSceneProxy</code> · <code>FRayTracingGeometryInitializer</code></td><td>01</td></tr>
<tr><td>2</td><td>렌더 스레드</td><td>표시된 메시마다 삼각형을 Ray가 빨리 찾을 수 있는 검색 자료구조로 미리 빌드한다. 한 프레임에 너무 많이 빌드하지 않도록 예산을 두고, 넘치면 다음 프레임으로 미루고, 한동안 안 쓰인 것은 메모리에서 내린다</td><td><code>FRayTracingGeometryManager::Tick</code> · <code>ProcessBuildRequests</code></td><td>02</td></tr>
<tr><td>3</td><td>워커 태스크</td><td>이번 프레임에 Ray가 맞을 수 있는 물체를 뷰마다 골라낸다. 안 움직이는 것, 지난 프레임 것을 다시 쓸 수 있는 것, 매 프레임 새로 넣어야 하는 것으로 나누고, 새로 넣을 것은 여러 스레드가 나눠 모은다</td><td><code>GatherRelevantPrimitives</code> · <code>RayTracing_GatherDynamicRayTracingInstances</code></td><td>03</td></tr>
<tr><td>4</td><td>렌더 스레드</td><td>여러 스레드가 나눠 모을 수 없는 물체는 렌더 스레드가 직접 모은다. 스키닝처럼 이번 프레임에 모양이 바뀐 메시는 검색 자료구조를 조금만 고칠지 통째로 다시 빌드할지 정해 GPU 작업으로 예약한다</td><td><code>RayTracing_FinishGatherInstances</code> · <code>ScheduleUpdates</code></td><td>04</td></tr>
<tr><td>5</td><td>워커 태스크</td><td>골라낸 물체를 이번 프레임의 씬 목록에 넣는다. 같은 메시를 쓰는 물체는 하나로 묶고, 물체마다 "Ray가 맞으면 어느 셰이더를 실행할지" 적어 둘 연결표의 자리를 배정한다</td><td><code>AddStaticInstancesToRayTracingScene</code> · <code>AddVisibleCachedInstances</code></td><td>04</td></tr>
<tr><td>6</td><td>렌더 스레드</td><td>모양이 바뀐 메시의 정점을 GPU에서 다시 계산하는 패스, 그 메시의 검색 자료구조를 고치는 패스, 씬의 물체 전체를 하나로 묶는 상위 검색 자료구조를 빌드하는 패스를 GPU 작업 목록(RDG)에 등록한다</td><td><code>DispatchRayTracingWorldUpdates</code> · <code>FRayTracingScene::Update/Build</code></td><td>05</td></tr>
<tr><td>7</td><td>렌더 스레드</td><td>Ray가 맞았을 때 실행될 셰이더들을 GPU용 파이프라인 하나로 묶어 만들고(시간이 걸려 비동기로), 연결표에서 이번 프레임에 바뀐 칸만 다시 써서 GPU에 올린다</td><td><code>SetupRayTracingRenderingData</code> · <code>CommitShaderBindingTable</code></td><td>06</td></tr>
<tr><td>8</td><td>RHI 스레드</td><td>렌더 스레드가 등록만 해 둔 GPU 작업을 실제 D3D12 커맨드로 번역한다. 검색 자료구조를 어떤 옵션으로 빌드할지, 버퍼가 몇 바이트 필요한지가 여기서 정해진다</td><td><code>RHI_Translate</code> · <code>RayTracingDynamicGeometry</code> · <code>BuildAccelerationStructure_BottomLevel</code></td><td>07</td></tr>
<tr><td>9</td><td>GPU</td><td>바뀐 정점을 쓰고, 메시별 검색 자료구조를 빌드하고, 씬 전체 검색 자료구조를 빌드하고, Ray를 쏜다. Ray가 맞거나 빗나갔을 때 어떤 셰이더가 어떤 순서로 도는지, Ray가 들고 다니는 데이터는 무엇인지를 여기서 다룬다</td><td><code>RayTracingDynamicUpdate</code> → 자료구조 빌드 → <code>DispatchRays</code> 또는 컴퓨트 <code>Dispatch</code></td><td>08 · 09</td></tr>
<tr><td>10</td><td>GPU → CPU</td><td>GPU가 남긴 기록(어떤 메시가 실제로 Ray에 맞았는지, 자료구조를 얼마나 더 작게 줄일 수 있는지)을 CPU로 읽어 오고, 이번 프레임용 임시 상태를 지워 다음 프레임에 넘긴다</td><td><code>FinishTracingFeedback</code> · 압축 크기 리드백 · <code>EndFrame</code></td><td>10</td></tr>
</table>
</div>
<p style="color:var(--text2);line-height:1.85;">
눈여겨볼 것은 <strong>씬을 준비하는 일(빌드)과 Ray를 쏘는 일(셰이딩)이 분리</strong>돼 있다는 점이다. 프레임 전반부는 "이번 프레임에 트레이스 가능한 씬을 준비"하는 데 쓰인다. 예산 안에서 검색 자료구조를 빌드하고, 모양이 바뀐 메시를 갱신하고, 씬 전체를 하나로 묶고, 연결표를 엮는다. 후반부에 비로소 각 이펙트가 그 위에 Ray를 쏜다. 준비된 이 <strong>공용 인프라</strong>를 여러 이펙트가 공유하는 것이 11장의 주제다.
</p>
<p style="color:var(--text2);line-height:1.85;">
각 장의 앞부분은 "그 단계에서 실제로 일어나는 일"이고, 뒷부분은 그 일을 이해하는 데 필요한 이론이다. 레이 트레이싱이 처음이라면 01장부터 차례로 읽으면 되고, DXR(DirectX Raytracing, D3D12의 레이 트레이싱 API)에 익숙하고 언리얼의 스케줄링만 궁금하다면 02·04·05·06장만 이어 읽어도 이야기가 닫힌다. GPU 쪽 하드웨어와 셰이더가 궁금하면 08·09장으로 바로 가도 된다.
</p>
<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
<p>1차 출처는 로컬 UE 5.8 소스(<code>D:\UnrealEngine_5_8</code>)다. 본 파일은 <code>D3D12RHI/Private/D3D12RayTracing.cpp</code>, <code>Renderer/Private/RayTracing/RayTracingScene.{h,cpp}</code> · <code>RayTracingShaderBindingTable.cpp</code> · <code>RayTracingMaterialHitShaders.cpp</code>, <code>Engine/Shaders/Private/RayTracing/RayTracingCommon.ush</code>, 그리고 활용처의 <code>RayTracingShadows.cpp</code> · <code>LumenHardwareRayTracing*</code> · <code>PathTracing.cpp</code>다. 파일:라인은 5.8 체크아웃 기준이라 버전이 바뀌면 달라질 수 있다. DXR 개념·모범 사례는 <strong>Microsoft DXR 스펙</strong>과 <strong>NVIDIA RTX 레이 트레이싱 모범 사례 및 메모리 압축(compaction) 블로그</strong>에서 직접 대조·검증했다. 08장의 벤더별 하드웨어 구성은 NVIDIA·AMD·Intel의 아키텍처 문서와 공개 ISA 분석에 근거했다(하단 참고).</p>
</div>

<span class="section-eyebrow">01. Game Thread</span>
</div>

# 게임 스레드: 레이 트레이싱을 빠르게 연산할 수 있는 자료구조를 만들 준비를 한다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
프레임은 게임 스레드에서 시작한다. 액터와 컴포넌트가 등록되거나 트랜스폼이 바뀌면 <code>FScene::AddPrimitive</code>·<code>UpdatePrimitiveTransform</code> 같은 요청이 렌더 스레드로 enqueue되고, 컴포넌트는 <code>CreateSceneProxy</code>로 자기 렌더 스레드 대리자인 <code>FPrimitiveSceneProxy</code>를 만든다. 렌더러는 이렇게 프록시가 된 물체 하나를 <strong>프리미티브</strong>라 부른다. 레이 트레이싱 관점에서 프록시가 들고 넘어가는 것은 세 종류의 플래그다. 이 프리미티브를 레이 트레이싱 씬에 넣을지(<code>bVisibleInRayTracing</code>, 컴포넌트의 Visible in Ray Tracing 옵션), 매 프레임 씬에 새로 등록해야 하는 <strong>동적</strong> 프리미티브인지 아니면 한 번 등록한 것을 캐시해 두는 <strong>정적</strong> 프리미티브인지, 그리고 동적이라면 워커 태스크에서 병렬로 수집해도 되는지(<code>bSupportsParallelGDRTI</code>)다. 마지막 플래그의 기본값은 병렬 허용이고, 엔진 전체에서 이를 끄는 프록시는 Niagara 컴포넌트 하나다. 그 결과는 03·04장에서 본다.
</p>
<p style="color:var(--text2);line-height:1.85;">
메시 자체는 다른 경로로 준비된다. 스태틱 메시의 렌더 데이터가 초기화될 때 LOD마다 <code>FRayTracingGeometry</code>가 하나씩 만들어지고, 그 안의 <code>FRayTracingGeometryInitializer</code>가 "이 메시의 Ray 검색용 자료구조를 어떻게 빌드할지"의 설계도가 된다. 설계도는 리소스 초기화에서 채워지지만 실제 빌드 요청은 렌더 스레드의 <code>FRayTracingGeometryManager</code> 큐에 쌓인다(02장). 그리고 <strong>움직이기만 하는 액터는 이 설계도를 다시 만들지 않는다</strong>. 위치·회전은 씬 전체를 묶는 상위 자료구조에 적힌 변환 행렬에만 반영된다(05장). 메시 자체의 자료구조를 다시 손대는 것은 정점이 바뀌는 지오메트리뿐이다(04장). 설계도에 무엇이 들어가는지 보기 전에, 그 설계도가 왜 필요한지부터 짚어 두자.
</p>

<span class="section-eyebrow">이 단계의 이론: 왜 트리이고, 왜 두 층인가</span>

<p style="color:var(--text2);line-height:1.85;">
01장 제목에서 말한 "레이 트레이싱을 빠르게 연산할 수 있는 자료구조"가 이 절의 주제다. 이걸 프로그래머들은 직접 만들어 두고 <strong>가속 구조(acceleration structure)</strong>라고 부른다. Ray가 hit를 찾는 계산을 빠르게 해 주는 구조라는 뜻이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
레이 트레이싱의 비용은 대부분 hit를 찾는 API 호출에 몰려 있다. <code>FindClosestHit(scene, ray)</code>, 즉 씬에서 Ray가 가장 먼저 맞는 삼각형을 찾는 호출이다(Ray 하나의 전체 흐름은 08장에서 본다). 가장 단순한 구현은 씬의 <strong>모든 삼각형</strong>에 대해 하나씩 교차를 검사하고 그중 가장 가까운 것을 고르는 것이다. 문제는 규모다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">문제</div><div class="step-name">삼각형이 1000만 개면?</div><div class="step-desc">요즘 게임 씬의 평범한 규모</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">순진한 답</div><div class="step-name">전부 검사?</div><div class="step-desc">Ray 하나마다 1000만 번 교차 검사</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">결과</div><div class="step-name">너무 느림</div><div class="step-desc">픽셀 200만 × 1000만 = 20조 번/프레임</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">해법</div><div class="step-name">box로 묶기</div><div class="step-desc">box로 묶어 통째로 걸러낸다 → log N</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
숫자로 보자. 1080p 화면은 픽셀이 약 200만 개고, 그림자·반사까지 계산하려면 픽셀당 Ray를 몇 개씩 쏜다. 삼각형 1000만 개짜리 씬에서 픽셀당 Ray 하나만 쏴도 교차 검사가 <strong>200만 × 1000만 = 20조 번</strong>이다. 초당 60프레임은커녕 한 프레임에 몇 분이 걸린다. 계산되는 과정을 자세히 들여다보면 문제가 명확히 보인다. Ray 하나는 씬의 극히 일부만 지나가는데, 나머지 999만 몇천 개의 삼각형까지 전부 헛검사하는 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
해법은 검사를 빨리 하는 게 아니라 <strong>안 해도 되는 검사를 통째로 걸러내는 것</strong>이다. 가까이 있는 삼각형 몇 개를 box<span class="fn-note"><input type="checkbox" id="fn-aabb" class="fn-toggle"><label for="fn-aabb" class="fn-ref">2</label><span class="fn-body"><strong>AABB(axis-aligned bounding box):</strong> 물체를 감싸고 있는 box. 면이 좌표축에 평행한 직육면체라 최소·최대 좌표 여섯 개 숫자로 표현되고, Ray와의 교차 검사가 Ray-삼각형 검사보다 훨씬 싸다. BVH에서 삼각형들을 묶는 box가 전부 이것이다.</span></span>로 감싸고, box 몇 개를 더 큰 box로 감싼다. 이걸 반복해 올라가면 트리가 된다. 이것이 <strong>BVH(Bounding Volume Hierarchy, 경계 볼륨 계층)</strong>다. Ray는 트리 꼭대기의 큰 box부터 검사하며 내려온다. box를 빗나가면? <strong>그 box 안의 삼각형 전부를 검사 없이 건너뛴다.</strong> box를 맞았을 때만 열어서 자식 box를 검사하고, 맨 아래 잎(leaf)에 도달해야 비로소 진짜 Ray-삼각형 검사를 한다. 검사 횟수가 삼각형 개수 N에 비례하지 않고 <strong>log N</strong>에 비례하게 되는 것이다. 1000만 번이 수십 번 수준으로 줄어든다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace">
<defs><marker id="rtx-ah-blue2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4338ca"/></marker></defs>
<!-- 루트 box -->
<rect x="30" y="22" width="580" height="218" fill="none" stroke="rgba(123,130,150,0.45)" stroke-width="1.2" stroke-dasharray="3 4"/>
<text x="42" y="40" fill="#7e8295" font-size="10.5">루트 box: 씬 전체</text>
<!-- box A (맞음) -->
<rect x="48" y="52" width="250" height="178" fill="rgba(67,56,202,0.04)" stroke="#4338ca" stroke-width="1.6"/>
<text x="58" y="68" fill="#4338ca" font-size="10.5">A: box 맞음 → 연다</text>
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
<!-- box B (빗나감) -->
<rect x="340" y="52" width="255" height="120" fill="rgba(123,130,150,0.06)" stroke="#7e8295" stroke-width="1.3" stroke-dasharray="4 3"/>
<path d="M 360,152 l 14,-22 l 13,23 z" fill="rgba(123,130,150,0.22)" stroke="#7e8295" stroke-width="1"/>
<path d="M 402,150 l 16,-24 l 14,25 z" fill="rgba(123,130,150,0.22)" stroke="#7e8295" stroke-width="1"/>
<path d="M 455,154 l 13,-20 l 12,21 z" fill="rgba(123,130,150,0.22)" stroke="#7e8295" stroke-width="1"/>
<path d="M 505,152 l 17,-26 l 15,27 z" fill="rgba(123,130,150,0.22)" stroke="#7e8295" stroke-width="1"/>
<path d="M 553,150 l 12,-18 l 11,19 z" fill="rgba(123,130,150,0.22)" stroke="#7e8295" stroke-width="1"/>
<text x="467" y="190" fill="#7e8295" font-size="10.5" text-anchor="middle">B: 빗나감 → 안의 삼각형 전부 스킵 (검사 0회)</text>
<!-- Ray -->
<line x1="2" y1="196" x2="184" y2="196" stroke="#4338ca" stroke-width="2" marker-end="url(#rtx-ah-blue2)"/>
<circle cx="190" cy="196" r="4.5" fill="#d6304a"/>
<text x="34" y="186" fill="#4338ca" font-size="11">Ray</text>
<text x="190" y="248" fill="#d6304a" font-size="10.5" text-anchor="middle">잎에서만 삼각형 검사 → 히트</text>
</svg>
<div class="scene-cap">BVH 트래버설에서 Ray는 box부터 검사한다. 빗나간 box(회색 점선)는 내부 삼각형을 하나도 검사하지 않고 통째로 건너뛰고, 맞은 box(파란 실선)만 열어 내려간다. 1000만 번의 검사가 수십 번으로 줄어드는 원리다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
그리고 이 <strong>트래버설(traversal)</strong>, 즉 Ray가 트리를 타고 내려가며 교차를 찾는 과정은 하드웨어에 넣기 딱 좋은 모양이다. "box 검사 → 맞으면 자식으로, 빗나가면 다음으로"의 단순 반복이라 회로로 굳히기 쉽고, 픽셀 수백만 개가 서로 독립적으로 같은 일을 하니 병렬화도 완벽하다. 그래서 2018년 NVIDIA RTX(Turing) 세대부터 GPU에 Ray-box·Ray-삼각형 교차를 전담하는 <strong>RT 코어</strong>가 들어갔고, 이것을 그래픽 API 표준으로 노출한 것이 <strong>DXR(DirectX Raytracing)</strong>이다. 단, 경계선을 정확히 긋자. 하드웨어가 대신해 주는 것은 <strong>트래버설</strong>이지, BVH를 만들고·갱신하고·Ray가 맞은 물체에 어떤 셰이더를 실행할지 정하는 일이 아니다. 그건 여전히 엔진의 몫이고, 이 글이 프레임 순서대로 따라가는 것이 바로 그 일이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
DXR은 이 트리를 통째로 하나 두지 않고 <strong>두 층</strong>으로 나눈다. 메시 하나의 삼각형 트리가 <strong>BLAS</strong>(bottom-level acceleration structure)고, 그 BLAS를 월드 여기저기에 놓은 복사본, 즉 인스턴스들을 다시 묶은 트리가 <strong>TLAS</strong>(top-level)다. 01장의 설계도 <code>FRayTracingGeometryInitializer</code>가 만드는 것이 BLAS 쪽이고, 05장이 매 프레임 다시 빌드하는 것이 TLAS 쪽이다. 왜 굳이 나누는지는 이름에서부터 보인다.
</p>
<p style="color:var(--text2);line-height:1.85;">
두 이름이 왜 <strong>top</strong>과 <strong>bottom</strong>인지부터 보면 구조가 한 번에 잡힌다. 바로 위에서 만든 BVH는 씬 전체를 덮는 <strong>트리 하나</strong>였다. 뿌리에는 커다란 box가 있고, 내려갈수록 box가 작아지다가 맨 아래 잎에서 삼각형을 만난다. 이 트리를 <strong>물체 경계에서 가로로 한 번 자르면</strong> 조각이 둘 나온다. 위 조각에는 "물체를 하나씩 감싼 box들"이 남고, 아래 조각에는 "물체 하나 안의 삼각형들을 감싼 box들"이 남는다. <strong>위 조각이 TLAS(top-level), 아래 조각이 BLAS(bottom-level)</strong>다. 이름 그대로다. 서로 무관한 두 자료구조가 아니라, 원래 하나였던 계층을 두 조각으로 잘라 따로 관리하는 것이다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace">
<defs><marker id="rtx-cut-gray" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#414455"/></marker></defs>
<!-- 왼쪽: 트리 하나 -->
<rect x="120" y="14" width="64" height="20" rx="4" fill="rgba(123,130,150,0.12)" stroke="#7e8295" stroke-width="1.2"/>
<text x="152" y="28" fill="#414455" font-size="9.5" text-anchor="middle">씬 전체</text>
<line x1="140" y1="34" x2="88" y2="58" stroke="#7e8295" stroke-width="1"/>
<line x1="164" y1="34" x2="216" y2="58" stroke="#7e8295" stroke-width="1"/>
<rect x="48" y="58" width="64" height="20" rx="4" fill="rgba(67,56,202,0.10)" stroke="#4338ca" stroke-width="1.2"/>
<text x="80" y="72" fill="#4338ca" font-size="9.5" text-anchor="middle">물체 A</text>
<rect x="184" y="58" width="64" height="20" rx="4" fill="rgba(67,56,202,0.10)" stroke="#4338ca" stroke-width="1.2"/>
<text x="216" y="72" fill="#4338ca" font-size="9.5" text-anchor="middle">물체 B</text>
<line x1="70" y1="78" x2="56" y2="112" stroke="#7e8295" stroke-width="1"/>
<line x1="92" y1="78" x2="106" y2="112" stroke="#7e8295" stroke-width="1"/>
<line x1="206" y1="78" x2="192" y2="112" stroke="#7e8295" stroke-width="1"/>
<line x1="228" y1="78" x2="242" y2="112" stroke="#7e8295" stroke-width="1"/>
<path d="M 44,138 l 12,-24 l 11,25 z" fill="rgba(10,143,114,0.22)" stroke="#0a8f72" stroke-width="1"/>
<path d="M 94,138 l 12,-24 l 11,25 z" fill="rgba(10,143,114,0.22)" stroke="#0a8f72" stroke-width="1"/>
<path d="M 180,138 l 12,-24 l 11,25 z" fill="rgba(10,143,114,0.22)" stroke="#0a8f72" stroke-width="1"/>
<path d="M 230,138 l 12,-24 l 11,25 z" fill="rgba(10,143,114,0.22)" stroke="#0a8f72" stroke-width="1"/>
<text x="146" y="156" fill="#0a8f72" font-size="9.5" text-anchor="middle">삼각형</text>
<!-- 절단선 -->
<line x1="24" y1="94" x2="272" y2="94" stroke="#d6304a" stroke-width="1.5" stroke-dasharray="6 4"/>
<text x="148" y="90" fill="#d6304a" font-size="9.5" text-anchor="middle">물체 경계에서 자른다</text>
<text x="148" y="180" fill="#7e8295" font-size="10" text-anchor="middle">트리 하나</text>
<!-- 화살표 -->
<line x1="292" y1="96" x2="340" y2="96" stroke="#414455" stroke-width="1.6" marker-end="url(#rtx-cut-gray)"/>
<!-- 오른쪽: 두 조각 -->
<rect x="360" y="14" width="256" height="66" fill="rgba(67,56,202,0.05)" stroke="#4338ca" stroke-width="1.5" stroke-dasharray="4 3"/>
<text x="372" y="34" fill="#4338ca" font-size="10.5">TLAS (위 조각)</text>
<text x="372" y="52" fill="#7e8295" font-size="9.5">물체를 하나씩 감싼 box들</text>
<text x="372" y="68" fill="#7e8295" font-size="9.5">월드 좌표계 · 매 프레임 재빌드</text>
<line x1="488" y1="80" x2="488" y2="110" stroke="#7e8295" stroke-width="1.2" stroke-dasharray="3 3"/>
<text x="498" y="99" fill="#7e8295" font-size="9">인스턴스가 아래 조각을 참조</text>
<rect x="360" y="110" width="256" height="70" fill="rgba(10,143,114,0.06)" stroke="#0a8f72" stroke-width="1.6"/>
<text x="372" y="130" fill="#0a8f72" font-size="10.5">BLAS (아래 조각)</text>
<text x="372" y="148" fill="#7e8295" font-size="9.5">물체 하나 안의 삼각형들</text>
<text x="372" y="164" fill="#7e8295" font-size="9.5">모델 좌표계 · 물체마다 하나</text>
</svg>
<div class="scene-cap">두 층은 트리 하나를 물체 경계에서 자른 위 조각과 아래 조각이다. 그래서 이름이 top-level과 bottom-level이다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
순회도 자른 순서를 그대로 따른다. Ray는 <strong>위 조각(TLAS)을 먼저 타고 내려와 어떤 물체에 닿을지 가리고, 닿은 물체의 아래 조각(BLAS)으로 이어서 내려가 삼각형을 찾는다</strong>. "TLAS로 물체를 고르고, BLAS로 그 물체 안을 뒤진다"가 두 층이 하는 일의 전부다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그럼 왜 자르나. 자르지 않고 트리 하나로 두면 곤란해지는 게 두 가지다. 숫자로 보는 편이 빠르다. 삼각형 5000개짜리 나무 메시가 숲에 1000그루 서 있는 씬을 가정해 보자.
</p>

<div class="data-table">
<table>
<tr><th></th><th>자르지 않으면 (트리 하나)</th><th>자르면 (두 층)</th></tr>
<tr><td>저장되는 삼각형 트리</td><td>5000 × 1000 = <strong>500만 삼각형</strong> 분량</td><td><strong>5000 삼각형 분량 한 벌</strong> (1000그루가 공유)</td></tr>
<tr><td>나무 한 그루가 흔들리면</td><td>그 box부터 뿌리까지 어긋나 <strong>트리 전체 재빌드</strong></td><td>위 조각만 다시. 아래 조각은 손대지 않음</td></tr>
<tr><td>매 프레임 다시 빌드해야 하는 양</td><td>500만 삼각형 BVH</td><td>인스턴스 1000개 = <strong>수십 KB</strong></td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
아래 조각이 <strong>물체 하나 단위</strong>로 잘려 있으니 같은 메시를 몇 번 놓든 한 벌이면 되고, 물체가 움직여도 그 물체 안의 삼각형 배치는 바뀌지 않으니 다시 빌드할 것은 위 조각뿐이다. 거의 안 바뀌는 정보와 매 프레임 바뀌는 정보를 한 자료구조에 섞지 않는다는, 아주 흔한 설계다.
</p>

<p style="color:var(--text2);line-height:1.85;">
공짜는 아니다. 자르면 <strong>두 조각의 좌표계가 갈린다</strong>. 위 조각은 씬을 다루니 <strong>월드 좌표계</strong>여야 하고, 아래 조각은 여러 곳에서 공유되어야 하니 특정 위치에 묶일 수 없다. 그래서 BLAS는 그 메시 자신의 <strong>모델(로컬) 좌표계</strong>에 만들어진다. 나무 BLAS는 "원점에 서 있는 나무 한 그루"이고, 그걸 숲의 각 자리로 옮기는 정보는 위 조각이 들고 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그 옮기는 정보가 <strong>인스턴스</strong>다. TLAS 안에는 삼각형이 하나도 없고 인스턴스만 들어간다. 인스턴스 하나는 (4×3 <strong>변환 행렬</strong> + 참조할 <strong>BLAS의 GPU 주소</strong> + <code>InstanceID</code> + 8비트 <strong>마스크</strong> + 플래그)로, 요컨대 "어떤 BLAS를 월드에 어떤 트랜스폼으로 놓을지"만 적어둔 쪽지다. 쪽지 하나가 수십 바이트니 인스턴스 수천 개짜리 TLAS도 삼각형 BVH에 비하면 가볍고, 그래서 매 프레임 통째로 다시 빌드<span class="fn-note"><input type="checkbox" id="fn-build" class="fn-toggle"><label for="fn-build" class="fn-ref">3</label><span class="fn-body"><strong>빌드(build):</strong> 삼각형 목록(TLAS라면 인스턴스 목록)을 입력으로 받아 드라이버와 GPU가 BVH 트리를 처음부터 새로 만드는 작업. 입력마다 box를 구하고, 가까운 것끼리 묶어 노드로 나누고, 그 노드 계층을 GPU 버퍼에 써 넣는다. DXR에서는 <code>BuildRaytracingAccelerationStructure</code> 호출 하나가 이 일을 맡고(언리얼의 <code>FRayTracingScene::Build</code>와 <code>RHIBuildAccelerationStructures</code>는 그 호출을 기록하는 쪽이다), 트리 모양은 그대로 두고 좌표만 갱신하는 값싼 갱신(04장)과 구분된다.</span></span>해도 감당이 된다(05장).
</p>

<span class="section-eyebrow">코드: FRayTracingGeometryInitializer</span>

<p style="color:var(--text2);line-height:1.85;">
BLAS는 언리얼에서 <code>FRayTracingGeometry</code>가 감싼다. RHI 레벨의 설계도가 <code>FRayTracingGeometryInitializer</code>(RHIResources.h)인데, 여기 들어가는 필드가 곧 "이 지오메트리를 어떻게 빌드할지"의 정책이다. 지오메트리 타입(<code>ERayTracingGeometryType</code>)은 세 가지다. 삼각형(<code>RTGT_Triangles</code>, 정점 stride ≥ 12바이트), 프로시저럴 AABB(<code>RTGT_Procedural</code>, 삼각형 대신 box만 주고 교차 판정을 셰이더가 직접 계산하는 타입. 그 셰이더가 intersection 셰이더다, 08장), 그리고 헤어용 선분-구(<code>RTGT_LinearSweptSpheres</code>, NVAPI 전용)다.
</p>

<p style="color:var(--text2);line-height:1.85;">
지오메트리는 <strong>세그먼트(segment)</strong>들로 쪼개지는데, 세그먼트 하나가 곧 머티리얼 섹션 하나다. <code>FRayTracingGeometrySegment</code>에는 정점 버퍼·오프셋·stride, 첫 프리미티브 인덱스, 프리미티브 개수, 그리고 두 개의 결정적 플래그가 있다. <strong><code>bForceOpaque</code></strong>와 <code>bEnabled</code>다. <code>bForceOpaque</code>는 any-hit 셰이더를 아예 끄는 플래그다. any-hit 셰이더는 Ray가 삼각형에 닿을 때마다 불려 그 히트를 인정할지 무시할지 정하는 셰이더로, 알파 마스크가 있는 나뭇잎 같은 재질에 쓰인다(08장). 불투명한 메시는 이 판정이 필요 없으니 꺼 둔다. 빌드 정책은 initializer의 세 플래그로 정해진다: <code>bFastBuild=false</code>(빠른 빌드보다 빠른 트레이스 선호), <code>bAllowUpdate=false</code>(refit 불가), <code>bAllowCompaction=true</code>(압축 허용). 여기서 <strong>refit</strong>은 트리를 처음부터 다시 빌드하지 않고 정점 위치만 바꿔 넣는 값싼 갱신이고(04장에서 자세히), <strong>compaction</strong>은 빌드 때 크게 잡아둔 메모리에서 실제로 쓰는 만큼만 남기고 회수하는 압축이다(07장에서 자세히). 지금은 이 정도만 알고 넘어가자. 정적 메시의 기본값은 "느리게라도 잘 빌드하고, 한 번 빌드하면 안 바꾸고, 대신 메모리는 압축한다"인 셈이다.
</p>

<div class="code-block"><div class="code-lang">C++ · StaticMesh.cpp (SetupRayTracingGeometryInitializer 요지)</div><span class="cm">// FStaticMeshSection 하나 = BLAS 세그먼트 하나</span>
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
LOD 리소스마다 <code>FRayTracingGeometry</code>가 하나씩 붙는다. 쿠킹 타임에 미리 빌드해둔 오프라인 BVH가 있으면(<code>OfflineData</code>) 런타임 빌드를 건너뛰고 그걸 로드하며, 없으면 런타임에 빌드한다. 여기서 <strong>Nanite</strong>는 특수 케이스다. Nanite 메시는 클러스터가 화면 기준으로 동적으로 바뀌므로 통째로 BVH를 만들 수 없다. 기본값은 <strong>fallback proxy 메시</strong>(저폴리 LOD)로 BLAS를 만드는 것이고(<code>r.RayTracing.Nanite.Mode=0</code>), 하드웨어가 클러스터 단위 가속 구조(CLAS)를 지원하면 모드 2로 올라간다. 단 <code>SupportsClusterOps</code>가 없으면 자동으로 fallback으로 다운그레이드된다.
</p>
<p style="color:var(--text2);line-height:1.85;">
설계도의 세 플래그가 뒤 단계의 갈림길을 미리 정한다. <code>bAllowUpdate</code>는 04장의 refit/rebuild 분류를, <code>bAllowCompaction</code>은 07장의 compaction 여부를, 세그먼트의 <code>bForceOpaque</code>는 06장의 any-hit 셰이더 유무를 결정한다. 게임 스레드는 여기까지다. 이 설계도를 실제 BVH로 만드는 요청은 렌더 스레드의 큐에서 다음 장부터 처리된다.
</p>

<span class="section-eyebrow">02. Render Thread · 프레임 시작</span>
</div>

# 렌더 스레드: 자료구조를 한꺼번에가 아니라 매 프레임 예산 안에서 조금씩 빌드한다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
렌더 스레드에서 레이 트레이싱과 관련해 가장 먼저 도는 것은 <code>FRayTracingGeometryManager</code>다. 진입점이 둘이다. 게임 스레드가 모든 뷰포트의 렌더를 마치며 enqueue하는 <code>Tick</code>은 residency(상주)·스트리밍 상태를 갱신하고 쓰이지 않는 BLAS를 메모리에서 내리며(evict), <code>FDeferredShadingSceneRenderer::Render</code> 초반의 <code>Update</code>와 <code>ProcessBuildRequests</code>가 쌓인 빌드 요청을 예산 안에서 처리한다. 여기서 "처리"는 빌드 커맨드를 RHI 커맨드 리스트에 기록하는 것까지고, 실제 D3D12 호출과 GPU 빌드는 07·08장에서 일어난다. 스테디 스테이트에서는 이 스코프가 거의 비어 있다. 새 메시가 스트리밍되거나 LOD가 바뀔 때만 일이 생기고, 그때 몰리는 빌드를 어떻게 분산하느냐가 이 장의 내용이다.
</p>
<p style="color:var(--text2);line-height:1.85;">
엔진이 하드웨어 위에서 돌리는 세 가지 일(빌드 스케줄링·메모리 관리·셰이더 연결표 관리) 중 첫 번째, <strong>빌드 스케줄링</strong>이다. 메시가 로드됐다고 BLAS를 그 자리에서 빌드하지 않는다. <code>FRayTracingGeometryManager</code>가 빌드 <strong>요청을 큐에 쌓고</strong>, 매 프레임 예산 안에서 우선순위 순으로 처리한다. 이유는 명백하다. 레벨 스트리밍으로 수천 개 메시가 한 프레임에 몰려 들어오면, 그걸 다 즉시 빌드하다가 프레임이 통째로 멈춘다(hitching). 빌드를 <strong>시간축에 분산</strong>시키는 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
우선순위는 네 단계로, <code>Immediate=1.0</code>, <code>High=0.5</code>, <code>Normal=0.24</code>, <code>Low=0.01</code>의 실수 가중치다. 매 프레임 <code>ProcessBuildRequests</code>(DeferredShadingRenderer가 프레임마다 호출)가 요청을 우선순위 내림차순으로 정렬한 뒤, <strong>프리미티브 예산</strong>(<code>r.RayTracing.Geometry.MaxBuiltPrimitivesPerFrame</code>) 안에서만 빌드하고 초과분은 다음 프레임으로 넘긴다. 기본값은 <strong>-1 = 무제한</strong>이라 기본 동작은 "가능한 다 빌드"지만, 예산을 걸면 프레임당 삼각형 수를 잘라서 프레임 멈춤을 막을 수 있다.
</p>

<div class="callout callout-info">
<div class="callout-title">기아 방지: priority boost</div>
<p>예산 방식의 함정은 <strong>낮은 우선순위 요청이 영원히 밀리는 것</strong>이다. 언리얼은 처리되지 못한 요청의 우선순위를 매 프레임 <code>+0.001</code>씩 올린다(<code>PendingBuildPriorityBoostPerFrame</code>). Low(0.01)로 들어온 요청도 충분히 오래 기다리면 결국 Normal·High를 추월해 빌드된다. 스케줄러의 고전적인 aging 기법이다. 여기에 scratch 메모리<span class="fn-note"><input type="checkbox" id="fn-scratch" class="fn-toggle"><label for="fn-scratch" class="fn-ref">4</label><span class="fn-body"><strong>scratch 메모리:</strong> 가속 구조를 빌드하는 동안에만 쓰는 임시 작업 버퍼. 빌드가 끝나면 필요 없어지므로 결과 버퍼와 따로 잡는다.</span></span> 요구량이 2GiB를 넘으면 그 프레임은 스킵하는 안전장치도 붙어 있다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
빌드된 BVH는 무한정 메모리에 남지 않는다. 언리얼은 <strong>reference 기반 residency</strong>(<code>r.RayTracing.UseReferenceBasedResidency</code>)로 실제 참조되는 지오메트리만 상주시키고 나머지는 evict한다. 상주 풀 크기는 <code>r.RayTracing.ResidentGeometryMemoryPoolSizeInMB=400</code>MB, 항상 상주하는 LOD 수는 <code>NumAlwaysResidentLODs=1</code>이다. 요청 큐·예산·aging·residency까지, 텍스처 스트리밍에서 익숙한 패턴이 BVH에 그대로 적용된 것이다.
</p>

<span class="section-eyebrow">03. Worker Tasks</span>
</div>

# 워커 태스크: 이번 프레임에 Ray가 맞을 수 있는 물체를 여러 스레드가 나눠 골라낸다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
<code>Render</code>는 <code>BeginInitViews</code>에 앞서 <code>RayTracing::BeginGatherInstances</code>를 호출해 태스크를 띄운다. 뷰마다 <code>GatherRelevantPrimitives</code>가 ParallelFor로 씬의 프리미티브를 훑어 RT에 넣을 것만 남긴다. 프러스텀 컬링 태스크의 결과를 선행 조건으로 받고, <code>r.RayTracing.Culling</code>(기본 3, 거리 또는 각도)·<code>Culling.Radius</code>(기본 30000, 300m)·<code>Culling.Angle</code>(기본 1°)로 카메라 뒤 먼 것과 화면에서 너무 작은 것을 버린다. 남은 것은 셋으로 갈린다. 프레임 간 인스턴스가 캐시된 정적 프리미티브(<code>CachedStaticPrimitives</code>), 매 프레임 머티리얼·바인딩을 다시 계산해야 하는 정적 프리미티브(<code>StaticPrimitives</code>), 그리고 매 프레임 인스턴스를 새로 만들어야 하는 동적 프리미티브(<code>DynamicPrimitivesIndices</code>)다. 뷰별 결과는 <code>FinalizeGatherRelevantPrimitives</code> 태스크가 합친다.
</p>
<p style="color:var(--text2);line-height:1.85;">
동적 프리미티브는 또 하나의 태스크 묶음이 처리한다. <code>BeginInitViews</code>가 선행 조건을 트리거하면 <code>r.RayTracing.DynamicInstances.Parallel.NumTasks</code>(기본 4)개의 컨텍스트가 공유 큐에서 프리미티브를 꺼내 각 프록시의 <code>GetDynamicRayTracingInstances</code>를 호출한다. 스켈레탈 메시가 스키닝 결과로 BLAS 갱신을 요청하고, 지오메트리 컬렉션이 조각별 인스턴스를 내는 곳이 여기다. 단 프록시가 <code>bSupportsParallelGDRTI</code>를 꺼 두었다면 큐에서 꺼내기만 하고 <strong>렌더 스레드 전용 목록</strong>에 넘긴다. 01장에서 말한 대로 엔진에서 이 플래그를 끄는 프록시는 Niagara 컴포넌트 하나뿐이어서, Niagara 렌더러의 RT 인스턴스 생성은 전부 04장의 렌더 스레드에서 일어난다. Niagara가 많은 씬에서 렌더 스레드의 RT 비용이 튀어 보이는 구조적인 이유다.
</p>
<p style="color:var(--text2);line-height:1.85;">
인스턴스는 성격에 따라 둘로 갈린다. <strong>Cached 인스턴스</strong>는 프레임 간 영속하며 free list로 관리되고(정적 메시), <strong>Transient 인스턴스</strong>는 매 프레임 새로 수집된다(동적). 캐시드 인스턴스는 뷰별 가시성 비트(<code>MarkInstanceVisible</code>)로 어느 뷰에 보이는지만 갱신하면 되니, 매 프레임 전체를 다시 모으는 비용을 아낀다.
</p>
<p style="color:var(--text2);line-height:1.85;">
이 장의 태스크들은 렌더 스레드와 나란히 돈다. 렌더 스레드는 그 사이 <code>BeginInitViews</code>에서 가시성·릴레번스 작업을 진행하고, 다음 장의 <code>FinishGatherInstances</code>에서 이 태스크들의 결과를 회수한다.
</p>

<span class="section-eyebrow">04. Render Thread · FinishGatherInstances</span>
</div>

# 렌더 스레드: 골라낸 물체를 확정하고, 모양이 바뀐 메시는 자료구조 갱신을 예약한다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
렌더 스레드는 <code>BeginInitViews</code>를 마친 뒤 <code>RayTracing::FinishGatherInstances</code>로 돌아온다. 프로파일러의 <code>RayTracing_FinishGatherInstances</code> 스코프가 이것이고, 하는 일은 순서대로 넷이다. 첫째, 뷰별 <code>FinalizeGatherRelevantPrimitives</code> 태스크를 기다리고 캐시된 인스턴스를 잠근다. 둘째, 병렬 동적 수집 태스크를 기다린 뒤 03장에서 넘어온 렌더 스레드 전용 프리미티브의 <code>GetDynamicRayTracingInstances</code>를 직접 호출한다(<code>RayTracing_GatherDynamicRayTracingInstances_RenderThread</code>). Niagara 스프라이트·리본 렌더러는 여기서 매 프레임 프로시저럴 지오메트리를 만들어 BLAS 빌드를 요청하고, Niagara 메시 렌더러는 스태틱 메시의 BLAS를 재사용하되 파티클마다 인스턴스 트랜스폼을 낸다. 셋째, 모인 BLAS 갱신 요청을 <code>FRayTracingDynamicGeometryUpdateManager</code>에 등록하고 동적 프리미티브 데이터를 GPUScene<span class="fn-note"><input type="checkbox" id="fn-gpuscene" class="fn-toggle"><label for="fn-gpuscene" class="fn-ref">5</label><span class="fn-body"><strong>GPUScene:</strong> 씬에 있는 모든 프리미티브의 변환 행렬·바운드 같은 정보를 GPU 버퍼 하나에 모아 두는 시스템. 셰이더가 CPU를 거치지 않고 물체 정보를 바로 읽을 수 있다.</span></span>에 올린다. 넷째, <code>ScheduleUpdates</code>가 요청을 refit인지 rebuild인지 분류하고, 변형 정점을 쓸 공유 버텍스 버퍼를 할당하고, 정점을 생성할 컴퓨트 디스패치 커맨드와 BLAS 빌드 파라미터를 만든다. 비용은 요청 수에 비례하고 기본 예산은 무제한이다. 아래 이론이 그 분류 기준이다.
</p>

<span class="section-eyebrow">이 단계의 이론: refit할까, rebuild할까</span>

<p style="color:var(--text2);line-height:1.85;">
정적 메시는 "한 번 빌드"로 끝이지만, 스키닝 캐릭터나 WPO(월드 포지션 오프셋) 머티리얼처럼 <strong>매 프레임 정점이 움직이는</strong> 지오메트리는 BVH를 계속 갱신해야 한다. 여기서 두 갈래가 있다. <strong>update(refit)</strong>는 트리 구조는 그대로 두고 정점 위치만 밀어넣어 빠르게 갱신하고, <strong>rebuild</strong>는 트리를 처음부터 다시 빌드한다. DXR 스펙은 이 트레이드오프를 못 박는다: "update된 구조는 (갱신 전후 모두) 처음부터 빌드한 정적 구조만큼 트레이싱 성능이 좋지 않다. 다만 update가 빌드보다 빠르다." 게다가 <strong>update는 정점 위치만 바꿀 수 있고 토폴로지(인덱스·삼각형 수)는 못 바꾼다</strong>.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 제약 때문에 언리얼을 포함한 여러 엔진은 refit으로 값싸게 갱신하되 주기적인 rebuild로 품질을 회복하는 설계를 택했다. <strong>스키닝은 정점만 움직이고 토폴로지는 불변</strong>이니 refit이 맞고, <strong>씬 구성 자체가 바뀌는 TLAS는 매 프레임 rebuild</strong>가 맞다. 그런데 하드웨어는 스키닝을 모른다. 본 행렬로 변형된 정점 위치를 누군가 미리 버퍼에 써놓아야 한다. 그 일을 하는 것이 <strong>컴퓨트 셰이더 <code>RayTracingDynamicGeometryConverterCS</code></strong>다. 이 CS는 머티리얼 셰이더로 컴파일되어(WPO·스키닝을 머티리얼 그래프대로 평가) 변형된 정점을 출력 버퍼에 써내고, 그 버퍼로 BLAS를 refit/rebuild한다.
</p>

<div class="code-block"><div class="code-lang">C++ · RayTracingDynamicGeometryUpdateManager.cpp (ClassifyBuildMode 요지)</div><span class="cm">// 기본: bAllowUpdate면 refit(Update)</span>
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
이 <code>ForceBuild</code> 로직이 정확히 NVIDIA 모범 사례가 말하는 것이다. "<strong>refit을 반복하면 BVH 품질이 점점 저하되므로 주기적으로 rebuild하는 것이 합리적</strong>"이며, "변형이 크고 예측 불가한 지오메트리(폭발 등)는 <code>ALLOW_UPDATE</code>를 생략하고 항상 rebuild하라". 언리얼은 전자를 <code>MinUpdatesSinceLastBuild</code> 카운터로, 후자를 정점 변형이 심한 메시의 빌드 정책으로 구현한다. refit은 공짜가 아니다. <strong>반복할수록 트리 품질이 떨어지고</strong>, 그 품질을 주기적인 rebuild로 회복시키는 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
효율을 위한 장치도 붙는다. 변형 정점은 공유 버퍼 풀(<code>SharedVertexBufferSizeInMB=4</code>, 30프레임 GC)에서 sub-allocate하고, <strong>tracing feedback</strong>(→ 10장)을 켜면 "지난 프레임에 실제로 Ray가 맞은" 동적 지오메트리만 갱신한다. 화면 뒤에서 아무도 안 보는 캐릭터의 BVH를 매 프레임 다시 만드는 낭비를 막는 것이다.
</p>

<span class="section-eyebrow">인스턴스 목록 확정: auto-instancing과 연결표 자리</span>

<p style="color:var(--text2);line-height:1.85;">
마지막으로 인스턴스 목록을 확정하는 태스크들을 띄운다. <code>AddDynamicInstancesToRayTracingScene</code>·<code>AddStaticInstancesToRayTracingScene</code>·<code>AddVisibleCachedInstances</code>가 워커에서 돌며 <code>FRayTracingScene</code>에 인스턴스를 넣고, 각 인스턴스가 "Ray가 맞으면 어느 셰이더를 실행할지" 적어 둘 연결표의 자리를 미리 잡는다. 이 연결표가 06장의 SBT다. 여기서 <strong>auto-instancing</strong>이 일어난다. 같은 지오메트리에 같은 그리기 설정(mesh command 플래그)을 가진 프리미티브들은 <code>InstancingKey()</code> 해시로 묶여 <strong>하나의 인스턴스로 배칭</strong>된다(<code>r.RayTracing.AutoInstance=1</code>). 숲의 나무 수천 그루가 인스턴스 하나로 접히는 식이다. 렌더 스레드는 이 태스크들을 기다리지 않고 다음 장으로 간다. 결과는 05장의 TLAS 패스와 06장의 연결표 셋업에서 회수된다.
</p>

<span class="section-eyebrow">05. Render Thread · TLAS</span>
</div>

# 렌더 스레드: 씬의 물체 전체를 하나로 묶는 상위 자료구조를 매 프레임 다시 빌드한다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
<code>DispatchRayTracingWorldUpdates</code>는 이름과 달리 GPU에 무엇을 바로 시키지 않는다. RDG<span class="fn-note"><input type="checkbox" id="fn-rdg" class="fn-toggle"><label for="fn-rdg" class="fn-ref">6</label><span class="fn-body"><strong>RDG(Render Dependency Graph):</strong> 렌더 스레드가 GPU 작업을 바로 실행하지 않고 패스 단위로 그래프에 등록해 두면, 프레임 끝에 의존 관계와 리소스 상태 전환을 계산해 한 번에 실행하는 프레임워크. 이 글에서 "패스를 등록한다"는 말은 전부 RDG에 등록한다는 뜻이다.</span></span> 패스를 등록할 뿐이고 실행은 07·08장이다. 등록 순서는 이렇다. Nanite RT 매니저의 스트리밍·업데이트·빌드 요청 처리, 04장이 만든 동적 지오메트리 갱신을 실행하는 두 패스(변형 정점을 쓰는 <code>RayTracingDynamicUpdate</code>와 그 정점으로 BLAS를 빌드하는 <code>RayTracingDynamicUpdateBuild</code>), 그리고 <code>FRayTracingScene</code>의 <code>Update</code>와 <code>Build</code>다. <code>r.RayTracing.AsyncBuild</code>가 켜져 있고 RHI가 지원하면 이 패스들은 비동기 컴퓨트 큐로 간다.
</p>
<p style="color:var(--text2);line-height:1.85;">
BLAS들이 준비되면 이제 씬 하나로 묶을 차례다. <code>FRayTracingScene</code>이 TLAS를 관리하는데, 그냥 하나가 아니라 <strong>레이어 3개</strong>로 나뉜다. <code>Base</code>(일반 지오메트리), <code>Decals</code>(데칼), <code>FarField</code>(Lumen 원거리 전용)다. 뷰마다·레이어마다 TLAS 버퍼·인스턴스 버퍼·scratch가 따로 있다. 다음 장에서 볼 셰이더 연결표(SBT)의 레이어는 Base/Decals 둘뿐이고, FarField는 Base의 것을 함께 쓴다.
</p>
<p style="color:var(--text2);line-height:1.85;">
<code>Update</code>에서는 흥미로운 일이 벌어진다. 04장에서 확정된 인스턴스 목록을 받아 인스턴스 디스크립터(변환 행렬 + BLAS 주소 + 마스크)를 <strong>CPU가 아니라 GPU에서</strong> 작성한다. <code>RayTracingBuildInstanceBufferCS</code>가 GPUScene의 변환을 읽어 native instance desc를 직접 써내고, 이때 <strong>인스턴스 컬링도 GPU에서</strong> 함께 처리한다. Nanite BLAS의 주소도 이 시점에 해결된다. 01장에서 "움직이기만 하는 액터는 설계도를 다시 만들지 않는다"고 했는데, 그 액터의 새 위치가 반영되는 자리가 정확히 여기다. GPUScene에 이미 올라간 변환을 읽어 인스턴스 한 줄을 다시 쓰는 것이 전부다.
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
TLAS를 매 프레임 <strong>FastTrace로 재빌드</strong>하는 이 선택은 NVIDIA 모범 사례와 정확히 일치한다. "TLAS는 <code>PREFER_FAST_TRACE</code>로 매 프레임 rebuild하라. refit의 이득이 트래버설 품질 손해를 정당화하지 못한다". TLAS는 인스턴스 수백~수천 개만 담아 상대적으로 가벼우니, 매번 최적 품질로 다시 빌드하는 게 남는 장사다. 단 Path Tracer는 컬링을 강제 해제한다. 오프라인 품질엔 화면 밖 지오메트리도 다 필요하기 때문이다.
</p>

<span class="section-eyebrow">이 단계의 이론: 인스턴스라는 쪽지</span>

<p style="color:var(--text2);line-height:1.85;">
01장에서 TLAS를 "물체를 하나씩 감싼 box들"이라고만 했다. 그 box 하나가 인스턴스이고, 이 장의 <code>Update</code>가 써내는 디스크립터가 바로 그 쪽지의 실체다. 그림으로 다시 보면 이렇다.
</p>
<div class="scene-fig">
<svg viewBox="0 0 640 336" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace">
<defs>
<marker id="rtx-2l-teal" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0a8f72"/></marker>
<marker id="rtx-2l-blue" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4338ca"/></marker>
</defs>
<!-- TLAS -->
<text x="40" y="24" fill="#4338ca" font-size="11">TLAS: 인스턴스들의 BVH (월드 좌표계 · 매 프레임 재빌드)</text>
<rect x="40" y="34" width="560" height="88" fill="rgba(67,56,202,0.04)" stroke="#4338ca" stroke-width="1.5" stroke-dasharray="4 3"/>
<line x1="4" y1="70" x2="34" y2="70" stroke="#4338ca" stroke-width="2" marker-end="url(#rtx-2l-blue)"/>
<text x="6" y="60" fill="#4338ca" font-size="10">Ray</text>
<g font-size="10">
<rect x="56" y="46" width="124" height="64" rx="4" fill="rgba(67,56,202,0.07)" stroke="#4338ca" stroke-width="1.2"/>
<text x="66" y="63" fill="#4338ca">인스턴스 0</text><text x="66" y="80" fill="#7e8295">변환 M₀</text><text x="66" y="97" fill="#7e8295">참조 → BLAS ①</text>
<rect x="194" y="46" width="124" height="64" rx="4" fill="rgba(67,56,202,0.07)" stroke="#4338ca" stroke-width="1.2"/>
<text x="204" y="63" fill="#4338ca">인스턴스 1</text><text x="204" y="80" fill="#7e8295">변환 M₁</text><text x="204" y="97" fill="#7e8295">참조 → BLAS ①</text>
<rect x="332" y="46" width="124" height="64" rx="4" fill="rgba(67,56,202,0.07)" stroke="#4338ca" stroke-width="1.2"/>
<text x="342" y="63" fill="#4338ca">인스턴스 2</text><text x="342" y="80" fill="#7e8295">변환 M₂</text><text x="342" y="97" fill="#7e8295">참조 → BLAS ①</text>
<rect x="470" y="46" width="124" height="64" rx="4" fill="rgba(67,56,202,0.07)" stroke="#4338ca" stroke-width="1.2"/>
<text x="480" y="63" fill="#4338ca">인스턴스 3</text><text x="480" y="80" fill="#7e8295">변환 M₃</text><text x="480" y="97" fill="#7e8295">참조 → BLAS ②</text>
</g>
<!-- 참조 화살표 -->
<path d="M 118,118 C 118,160 150,168 158,196" fill="none" stroke="#0a8f72" stroke-width="1.4" marker-end="url(#rtx-2l-teal)"/>
<path d="M 256,118 C 256,162 196,168 182,196" fill="none" stroke="#0a8f72" stroke-width="1.4" marker-end="url(#rtx-2l-teal)"/>
<path d="M 394,118 C 394,164 226,166 208,196" fill="none" stroke="#0a8f72" stroke-width="1.4" marker-end="url(#rtx-2l-teal)"/>
<path d="M 532,118 C 532,158 530,170 530,196" fill="none" stroke="#0a8f72" stroke-width="1.4" marker-end="url(#rtx-2l-teal)"/>
<text x="320" y="146" fill="#0a8f72" font-size="10" text-anchor="middle">BLAS 주소 참조 (삼각형은 복사되지 않는다)</text>
<!-- BLAS -->
<rect x="90" y="200" width="180" height="96" fill="rgba(10,143,114,0.06)" stroke="#0a8f72" stroke-width="1.6"/>
<text x="100" y="218" fill="#0a8f72" font-size="10.5">BLAS ①: 나무 메시</text>
<path d="M 112,282 l 16,-30 l 15,31 z" fill="rgba(10,143,114,0.22)" stroke="#0a8f72" stroke-width="1.1"/>
<path d="M 158,282 l 19,-36 l 16,37 z" fill="rgba(10,143,114,0.22)" stroke="#0a8f72" stroke-width="1.1"/>
<path d="M 210,281 l 14,-26 l 13,27 z" fill="rgba(10,143,114,0.22)" stroke="#0a8f72" stroke-width="1.1"/>
<rect x="440" y="200" width="180" height="96" fill="rgba(10,143,114,0.06)" stroke="#0a8f72" stroke-width="1.6"/>
<text x="450" y="218" fill="#0a8f72" font-size="10.5">BLAS ②: 바위 메시</text>
<path d="M 470,282 l 22,-34 l 20,35 z" fill="rgba(10,143,114,0.22)" stroke="#0a8f72" stroke-width="1.1"/>
<path d="M 528,281 l 18,-28 l 17,29 z" fill="rgba(10,143,114,0.22)" stroke="#0a8f72" stroke-width="1.1"/>
<text x="320" y="322" fill="#7e8295" font-size="10.5" text-anchor="middle">BLAS는 모델(로컬) 좌표계 · 메시마다 한 번 빌드 · 인스턴스 0·1·2가 BLAS ① 하나를 공유</text>
</svg>
<div class="scene-cap">두 층의 역할 분담. 위쪽 TLAS는 "어떤 BLAS를 어떤 트랜스폼으로 놓을지"만 담고, 아래쪽 BLAS가 실제 삼각형 트리를 담는다. 같은 메시를 세 번 놓아도 삼각형 트리는 한 벌뿐이다.</div>
</div>
<div class="card-grid">
<div class="card blue">
<div class="card-label">정리 ①</div>
<div class="card-title">메모리 재사용</div>
<div class="card-desc">같은 메시 N개 = BLAS 1개 + 인스턴스 N개. 숲·군중처럼 반복이 많은 씬에서 결정적이다. 언리얼의 auto-instancing(04장)이 이 이득을 코드로 챙기는 장치다.</div>
</div>
<div class="card teal">
<div class="card-label">정리 ②</div>
<div class="card-title">갱신 비용 분리</div>
<div class="card-desc">정적 메시 BLAS는 한 번 빌드하고 손대지 않고(01·02장), 매 프레임 다시 빌드하는 것은 TLAS뿐이다(05장). 캐릭터가 움직이면 그 캐릭터의 BLAS만 refit한다(04장).</div>
</div>
<div class="card purple">
<div class="card-label">정리 ③</div>
<div class="card-title">컬링·라우팅 지점</div>
<div class="card-desc">인스턴스에 붙는 8비트 마스크와 셰이더 연결표의 시작 위치가 "이 Ray가 이 물체를 볼지, 맞으면 어떤 셰이더를 돌릴지"를 정한다(06장). 거리·각도 컬링도 인스턴스 단위다(03장).</div>
</div>
</div>

<span class="section-eyebrow">06. Render Thread · SBT</span>
</div>

# 렌더 스레드: Ray가 맞은 물체에서 어느 셰이더를 실행할지 적은 연결표를 만든다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
TLAS 패스가 등록되면 렌더 스레드는 <code>SetupRayTracingRenderingData</code>로 셰이더 쪽을 마무리한다. 04장이 띄운 동적 바인딩 태스크를 기다리고(새로 나타난 머티리얼이 RTPSO<span class="fn-note"><input type="checkbox" id="fn-rtpso" class="fn-toggle"><label for="fn-rtpso" class="fn-ref">7</label><span class="fn-body"><strong>RTPSO(Ray Tracing Pipeline State Object):</strong> 이 프레임에 쓸 레이 트레이싱 셰이더(Ray를 쏘는 셰이더, 맞았을 때 도는 셰이더, 못 맞았을 때 도는 셰이더) 전부를 하나로 묶어 컴파일한 GPU 파이프라인 객체. 줄여서 PSO라고도 쓴다. 래스터의 PSO에 해당하지만 셰이더가 수백 개 들어가 만드는 데 훨씬 오래 걸린다.</span></span>에 들어가야 하므로), <code>SetupRayTracingPipelineStatesAndSBT</code>로 파이프라인과 SBT를 준비하고, 보이는 셰이더 바인딩 목록에서 바뀐 항목만 골라 다시 기록해 커밋한다. 여기서 SBT(Shader Binding Table)가 지금까지 "연결표"라고 부른 것의 정식 이름이다. Lumen·MegaLights처럼 전용 파이프라인 없이 컴퓨트 셰이더 안에서 Ray를 쏘는 inline 트레이싱(08장)을 쓰는 패스가 있으면, 물체별 히트 셰이더 정보를 별도 버퍼로도 만든다. 이 단계가 왜 필요한지, 그리고 SBT가 왜 악명 높은지부터 보자.
</p>
<p style="color:var(--text2);line-height:1.85;">
SBT가 왜 필요한지는 <strong>래스터와 비교하면 한 번에 드러난다</strong>. 래스터에서 물체를 그릴 때는 CPU가 draw call 직전에 "이번에 그릴 메시는 이 머티리얼 셰이더를 쓰고, 셰이더가 읽을 텍스처는 이것들"이라고 <strong>바인딩</strong>해 준다. 이게 가능한 이유는 단순하다. <strong>무엇을 그릴지 CPU가 알고 있기</strong> 때문이다. 메시 목록을 CPU가 들고 순회하며 하나씩 넘기니까.
</p>

<p style="color:var(--text2);line-height:1.85;">
레이 트레이싱에서는 이 전제가 무너진다. Ray가 <strong>무엇에 맞을지는 GPU가 순회를 끝내고 나서야</strong> 알 수 있다. 카메라에서 쏜 Ray가 나뭇잎에 맞을지 물웅덩이에 맞을지 CPU는 알 방법이 없고, 반사 Ray가 어디로 튈지는 더더욱 모른다. 그러니 "맞고 나서 어떤 셰이더를 실행할지"를 CPU가 미리 바인딩해 줄 수가 없다. <strong>GPU가 히트한 직후에 스스로 셰이더를 골라야 한다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 방식을 뒤집는다. CPU가 그때그때 바인딩하는 대신, 씬에 있는 <strong>모든 (지오메트리 × 레이 종류) 조합</strong>에 대해 "여기에 맞으면 이 셰이더를 실행하고, 그 셰이더가 쓸 리소스는 여기 있다"를 미리 표로 만들어 <strong>GPU 메모리에 깔아둔다</strong>. 그 표가 <strong>SBT(Shader Binding Table)</strong>다. 요컨대 <strong>CPU의 바인딩 호출을 GPU가 스스로 읽을 수 있는 배열로 옮겨놓은 것</strong>이고, 히트한 GPU 스레드는 이 배열에서 자기 줄을 찾아 읽으면 된다. 표에 들어가는 셰이더는 네 종류다. Ray가 물체에 맞았을 때 도는 셰이더 묶음(hit group), Ray를 처음 쏘는 셰이더(raygen), 아무것도 못 맞았을 때 도는 셰이더(miss), 다른 셰이더가 함수처럼 부르는 셰이더(callable)가 각자 이 표에 자기 구역을 갖는다. 이 셰이더들이 GPU에서 어떤 순서로 도는지는 08장에서 본다.
</p>

<p style="color:var(--text2);line-height:1.85;">
문제는 <strong>"자기 줄을 찾는" 방법</strong>이다. GPU는 자기가 몇 번째 줄을 읽어야 하는지 어디서도 통보받지 않는다. 대신 <strong>여러 곳에 흩어져 저장된 오프셋을 더해서 스스로 계산</strong>한다. 그 값을 앱이 미리 맞춰 넣어야 하고, 하나라도 어긋나면 조용히 엉뚱한 셰이더가 실행된다. DXR에서 SBT가 악명 높은 이유가 이 계산이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
구조부터 보면, SBT는 셰이더 레코드의 배열인데, 각 레코드는 <strong>32바이트 셰이더 식별자 + 로컬 루트 인수</strong>로 이뤄진다(DXR 스펙: 시작 주소 64바이트 정렬, stride 32바이트 배수, 최대 4096바이트). 앞서 말한 그 계산은 이렇게 생겼다.
</p>

<div class="formula">hitGroupRecordIndex =
    InstanceContributionToHitGroupIndex        // TLAS 인스턴스 desc에 기록
  + GeometryIndex × MultiplierForGeometryContribution   // = NUM_SHADER_SLOTS
  + RayContributionToHitGroupIndex             // TraceRay 인수 (레이 종류)</div>

<p style="color:var(--text2);line-height:1.85;">
세 항이 어디서 오는지가 중요하다. 첫 항은 <strong>인스턴스가 들고 있다</strong>. 01장에서 인스턴스를 "어떤 BLAS를 어떤 트랜스폼으로 놓을지 적어둔 쪽지"라고 했는데, 그 쪽지에 <strong>"내 셰이더 레코드는 표의 몇 번째 줄부터 시작한다"</strong>는 항목이 하나 더 있는 것이다. 둘째 항은 그 인스턴스 안에서 <strong>몇 번째 세그먼트(머티리얼 섹션)에 맞았는지</strong>로, 하드웨어가 순회 중에 채운다. 셋째 항은 셰이더에서 Ray 하나를 쏘는 함수 <code>TraceRay</code>를 부르는 쪽이 넘기는 값으로, <strong>이 Ray가 어떤 종류인지</strong>(머티리얼용인가 그림자용인가)를 나타낸다. 정리하면 <strong>"어느 물체에"(인스턴스) + "그 물체의 어느 부분에"(세그먼트) + "어떤 목적의 Ray가"(레이 종류)</strong> 맞았는지가 합쳐져 표의 줄 번호가 된다. 세 값의 주인이 셋으로 나뉘어 있으니 하나만 어긋나도 엉뚱한 셰이더가 실행되거나 GPU가 크래시한다. 언리얼은 이 계산을 <strong>자기 SBT 할당자로 관리한다</strong>. 설계의 출발점은 <code>RayTracingDefinitions.h</code>의 슬롯 배치다. <strong>세그먼트 하나당 레코드 2개</strong>를 둔다.
</p>

<div class="data-table">
<table>
<tr><th>슬롯</th><th>값</th><th>용도</th></tr>
<tr><td><code>RAY_TRACING_SHADER_SLOT_MATERIAL</code></td><td>0</td><td>풀 머티리얼 closest-hit 셰이더(가장 가까운 히트 지점에서 한 번 실행되는 셰이더, 이하 CHS). 셰이딩 담당</td></tr>
<tr><td><code>RAY_TRACING_SHADER_SLOT_SHADOW</code></td><td>1</td><td>그림자 전용(불투명이면 값싼 <code>OpaqueShadowCHS</code>)</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
그래서 <code>MultiplierForGeometryContribution = NUM_SHADER_SLOTS = 2</code>다. 세그먼트 0의 머티리얼 레코드가 인덱스 N에 있으면 그림자 레코드는 N+1, 세그먼트 1은 N+2·N+3에 있다. <code>TraceRay</code>가 <code>RayContribution</code>으로 0(머티리얼) 또는 1(그림자)을 주면 같은 세그먼트의 두 레코드 중 하나를 고른다. 여기에 <strong>miss 슬롯 2개</strong>(<code>DEFAULT=0</code>, <code>LIGHTING=1</code>)와 <strong>8비트 인스턴스 마스크</strong>가 더해진다. <code>OPAQUE=0x01</code>, <code>TRANSLUCENT=0x02</code>, <code>OPAQUE_SHADOW=0x04</code>, <code>HAIR_STRANDS=0x40</code>, <code>FarField=0x80</code> 등으로, <code>TraceRay</code>의 <code>InstanceInclusionMask</code>가 레이 종류별로 인스턴스를 필터링한다. 그림자 레이가 반투명만 골라 맞거나, Lumen이 FarField만 트레이스하는 게 이 마스크로 된다.
</p>

<div class="callout callout-purple">
<div class="callout-title">재귀 깊이 = 1</div>
<p>언리얼의 <code>RAY_TRACING_MAX_ALLOWED_RECURSION_DEPTH</code>는 <strong>1</strong>이다. hit 셰이더 안에서 또 <code>TraceRay</code>를 부르는 재귀를 쓰지 않는다는 뜻이다. 대신 raygen이 루프를 돌며 반사·바운스를 <strong>반복(iteration)</strong>으로 푼다. 재귀는 스택 메모리를 잡아먹고 하드웨어마다 한계가 다르니, 루프로 펴는 편이 성능·이식성 모두 유리하다. Path Tracer의 wavefront 구조(11장의 Path Tracer)가 이 철학의 극단이다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
할당은 <code>RayTracingShaderBindingTable.cpp</code>의 <code>FRayTracingSBTAllocation</code>이 맡는다. 정적 범위(<code>AllocateStaticRange</code>)는 {Geometry, Flags, SegmentCount}를 키로 <strong>dedup(refcount)</strong>해서 같은 지오메트리는 레코드를 공유하고, 동적 범위는 정적 최대치 뒤에서 bump-alloc하며 매 프레임 리셋된다. 그리고 <strong>persistent SBT</strong>(<code>r.RayTracing.PersistentSBT=1</code>)를 켜면 SBT를 프레임 간 유지하고 <strong>더러워진(dirty) 레코드만 다시 기록</strong>한다. 크기가 부족해지면 2배로 확장하며 전체를 dirty로 표시한다. 미지원 환경에서는 매 프레임 transient SBT를 새로 만든다. 바인딩 제출도 병렬이다. <code>FRayTracingLocalShaderBindingWriter</code>가 태스크당 1024개씩 수집해 merge한 뒤 <code>CommitShaderBindingTable</code>로 커밋한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
머티리얼 hit group 자체는 <code>TMaterialCHS&lt;라이트맵정책, AnyHit여부, Intersection여부, RayConeTexLOD여부&gt;</code>라는 <strong>템플릿 퍼뮤테이션</strong>이다. 엔트리 문자열이 스테이지를 결합한다: <code>"closesthit=MaterialCHS anyhit=MaterialAHS"</code> 같은 문자열이 <code>SF_RayHitGroup</code> 하나로 컴파일된다. any-hit이 붙느냐는 블렌드 모드가 정한다. <code>RTNeedsAnyHitShader(BlendMode)</code>가 Masked/Translucent/Modulate/AlphaComposite면 참, 즉 any-hit 셰이더(이하 AHS)가 필요하고, Opaque/Additive면 거짓이다. NVIDIA도 "<strong>any-hit은 트래버설을 중단시키므로 비싸다, 최소화하라</strong>"고 경고했다. 언리얼은 불투명 지오메트리에서 AHS를 아예 빼(01장의 <code>bForceOpaque</code>) 트래버설이 끊기지 않게 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
파이프라인 생성(<code>CreateMaterialRayTracingMaterialPipeline</code>)은 raygen 약 120개 + miss 라이브러리 + hit group 라이브러리(+필수 <code>OpaqueShadow</code>/<code>HiddenMaterial</code>)를 묶는다. 무거운 작업이라 <strong>논블로킹 비동기 생성</strong>(<code>r.RayTracing.NonBlockingPipelineCreation=1</code>)을 지원한다. PSO가 아직 준비 안 됐으면 지난 프레임의 fallback PSO를 쓰고 넘어간다. RT 파이프라인 컴파일로 프레임이 멈추는 것을 막는, 02장의 빌드 예산과 같은 목적의 장치다.
</p>

<span class="section-eyebrow">07. RHI Thread</span>
</div>

# RHI 스레드: 렌더 스레드가 등록해 둔 작업을 D3D12 커맨드로 번역한다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
<code>Render</code>가 끝나면 <code>FRDGBuilder::Execute</code>가 등록된 패스를 순서대로 실행한다. 패스의 람다는 RHI 커맨드 리스트에 명령을 기록하고, RHI 스레드가 켜져 있으면 그 리스트를 <code>RHI_Translate</code>에서 D3D12 커맨드로 번역한다. 프로파일러에서 RHI 스레드에 잡히는 <code>RayTracingDynamicGeometry</code> 스코프가 바로 04장의 갱신 요청이 커맨드가 되는 자리다. 안에는 정점 생성 컴퓨트 디스패치(<code>RayTracingDynamicGeometryUpdate</code>)와 BLAS 빌드(<code>BuildAccelerationStructure_BottomLevel</code>)가 있고, 이 CPU 비용은 삼각형 수보다 <strong>BLAS 개수</strong>에 비례한다. 작은 프로시저럴 지오메트리 수백 개가 큰 메시 몇 개보다 비싼 이유다. TLAS는 <code>BuildAccelerationStructures_TopLevel</code>로, 이펙트 패스는 <code>DispatchRays</code> 또는 컴퓨트 <code>Dispatch</code>로 기록된다. 빌드 플래그와 버퍼 크기가 최종 결정되는 곳도 여기다.
</p>
<p style="color:var(--text2);line-height:1.85;">
D3D12 레벨에서 재미있는 디테일 하나. BLAS를 생성하는 시점엔 인덱스 버퍼가 16비트인지 32비트인지 아직 모를 수 있다. 그래서 언리얼은 <strong>두 경우의 prebuild 정보(빌드 전에 드라이버에 "이 입력이면 버퍼가 얼마나 필요한가"를 물어 얻는 크기 정보)를 모두 구해 큰 쪽(max)으로 버퍼를 잡는다</strong>(<code>TranslateRayTracingGeometryDescs</code>). 빌드 플래그 변환도 여기서 일어난다. <code>bFastBuild</code>면 <code>PREFER_FAST_BUILD</code>, 아니면 <code>PREFER_FAST_TRACE</code>다. 그리고 compaction 플래그(<code>ALLOW_COMPACTION</code>)는 조건이 까다롭다.
</p>

<div class="code-block"><div class="code-lang">C++ · D3D12RayTracing.cpp (GetRayTracingAccelerationStructureBuildFlags 요지)</div><span class="ty">D3D12_..._BUILD_FLAGS</span> Flags = bFastBuild
    ? PREFER_FAST_BUILD : PREFER_FAST_TRACE;
<span class="kw">if</span> (bAllowUpdate) Flags |= ALLOW_UPDATE;

<span class="cm">// compaction은 "정적 메시"에만. refit도 fastbuild도 아니고, 충분히 클 때</span>
<span class="kw">if</span> (!bFastBuild &amp;&amp; !bAllowUpdate &amp;&amp; bAllowCompaction
        &amp;&amp; NumPrimitives &gt;= <span class="num">128</span>)
    Flags |= ALLOW_COMPACTION;</div>

<p style="color:var(--text2);line-height:1.85;">
<code>!bFastBuild &amp;&amp; !bAllowUpdate</code>라는 이 조건이 NVIDIA 모범 사례와 정확히 겹친다. NVIDIA compaction 문서는 "<code>PREFER_FAST_BUILD</code>나 <code>ALLOW_UPDATE</code>를 쓰지 않으면 최대 압축을 얻는다"고 명시한다. <code>ALLOW_UPDATE</code>는 refit을 위해 여유 공간을 예약하므로 압축과 상충하기 때문이다. 언리얼의 조건은 이 원리를 코드로 옮긴 것이다. 빌드가 끝나면 버퍼 상태를 <code>BVHWrite→BVHRead</code>로 전환하는 글로벌 배리어를 건다.
</p>

<span class="section-eyebrow">compaction: RHI 스레드에서 도는 멀티 프레임 상태 기계</span>

<p style="color:var(--text2);line-height:1.85;">
BLAS 빌드 커맨드를 기록하는 것과 나란히, D3D12 디바이스는 프레임마다 <code>FD3D12RayTracingCompactionRequestHandler::Update</code>를 돌린다. RHI 스레드에서 도는 이 핸들러가 07장의 마지막 주제, compaction이다.
</p>
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
배치 크기는 <code>r.D3D12.RayTracing.MaxBatchedCompaction=64</code>로, 리드백 오버헤드를 여러 BLAS에 분산시킨다. 그리고 프리미티브가 <code>Compaction.MinPrimitiveCount=128</code> 미만이면 아예 스킵한다. 작은 메시는 압축 이득보다 관리 오버헤드가 크기 때문이다(위 빌드 플래그 조건의 128과 같은 문턱값이다).
</p>

<div class="callout callout-purple">
<div class="callout-title">코드가 스펙을 그대로 옮긴 자리</div>
<p>NVIDIA compaction 문서는 워크플로를 이렇게 서술한다. "<code>ALLOW_COMPACTION</code>으로 빌드 → <code>EmitRaytracingAccelerationStructurePostbuildInfo(COMPACTED_SIZE)</code> → fence로 동기화 후 리드백 → <code>CopyRaytracingAccelerationStructure(COPY_MODE_COMPACT)</code>, 리드백 때문에 <strong>몇 프레임의 지연</strong>이 생김". 이 문장을 언리얼의 4단계 핸들러와 나란히 놓으면 단계가 1:1로 대응한다. 스펙이 "이렇게 하라"고 한 절차를, 엔진이 배치·문턱값·디바이스별 프레임 루프로 감싼 것이 이 핸들러다.</p>
</div>

<span class="section-eyebrow">08. GPU · 트래버설</span>
</div>

# GPU: Ray를 쏘라는 한 줄 뒤에서 여섯 종류의 셰이더가 차례로 돈다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
커맨드가 GPU에 닿으면 순서는 정해져 있다. 변형 정점을 쓰는 컴퓨트, BLAS 빌드와 refit, TLAS 빌드, 그리고 이펙트 패스의 Ray. 이 장은 그 마지막, <strong>Ray가 실제로 하는 일</strong>이다. 먼저 Ray 하나의 흐름을 잡고, DXR이 정의하는 여섯 스테이지, 01장의 두 층을 Ray가 지나는 순서, 그리고 그것을 처리하는 하드웨어를 차례로 본다.
</p>

<span class="section-eyebrow">Ray 하나: Camera → Ray → Hit → Color</span>

<p style="color:var(--text2);line-height:1.85;">
레이 트레이싱은 질문의 방향을 뒤집는다. 래스터라이제이션이 "삼각형이 어떤 픽셀을 덮는가"를 물었다면, 레이 트레이싱은 <strong>"픽셀에서 나간 Ray가 무엇에 맞는가"</strong>를 묻는다. Ray는 시작점(origin)과 방향(direction)을 가진 반직선이다. 카메라에서 픽셀 하나를 지나도록 Ray를 만들어 씬으로 내보내고, 그 Ray가 <strong>처음 맞는 삼각형</strong>을 찾고, 맞은 지점의 머티리얼과 조명을 평가해 색을 얻고, 그 색을 픽셀에 기록한다. 과정 전체가 여섯 단계다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">1 · Camera</div><div class="step-name">픽셀 선택</div><div class="step-desc">화면의 픽셀 하나를 고른다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">2 · Ray</div><div class="step-name">Ray 생성</div><div class="step-desc">카메라에서 그 픽셀을 지나는 Ray를 만든다</div></div>
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
<!-- Ray -->
<line x1="66" y1="122" x2="450" y2="106" stroke="#4338ca" stroke-width="2" marker-end="url(#rtx-ah-blue)"/>
<text x="255" y="102" fill="#4338ca" font-size="12" text-anchor="middle">Ray</text>
<!-- 삼각형과 히트 -->
<path d="M 440,38 L 418,158 L 560,128 Z" fill="rgba(180,83,9,0.14)" stroke="#b45309" stroke-width="1.6"/>
<circle cx="458" cy="105" r="4.5" fill="#d6304a"/>
<text x="505" y="178" fill="#d6304a" font-size="11" text-anchor="middle">Hit: 가장 가까운 교차</text>
<!-- 광원과 그림자 Ray -->
<circle cx="300" cy="32" r="9" fill="rgba(176,125,0,0.25)" stroke="#b07d00" stroke-width="1.4"/>
<path d="M300,16 V10 M300,48 V54 M284,32 H278 M316,32 H322 M289,21 L285,17 M311,21 L315,17 M289,43 L285,47 M311,43 L315,47" stroke="#b07d00" stroke-width="1.2"/>
<text x="337" y="26" fill="#b07d00" font-size="11">광원</text>
<line x1="452" y1="99" x2="310" y2="42" stroke="#b07d00" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#rtx-ah-gold)"/>
<text x="362" y="76" fill="#b07d00" font-size="10.5" text-anchor="middle">그림자 Ray: 막히면 그늘</text>
<!-- 색 반환 -->
<path d="M 455,114 C 390,208 220,208 130,130" fill="none" stroke="#d6304a" stroke-width="1.3" stroke-dasharray="4 4" marker-end="url(#rtx-ah-coral)"/>
<text x="300" y="222" fill="#d6304a" font-size="10.5" text-anchor="middle">Color: 평가한 색을 픽셀에 기록</text>
</svg>
<div class="scene-cap">카메라에서 픽셀을 지나 나간 Ray가 가장 가까운 삼각형에 맞고, 그 지점의 머티리얼·조명을 평가한 색이 픽셀로 돌아온다. 히트 지점에서 광원으로 쏘는 두 번째 Ray가 그림자를 판정한다.</div>
</div>

<div class="code-block"><div class="code-lang">의사 코드 · 레이 트레이싱의 뼈대</div><span class="cm">// 화면의 모든 픽셀을 하나씩 처리한다. 픽셀끼리 서로 독립이라 GPU가 수백만 개를 동시에 돌릴 수 있다</span>
<span class="kw">for</span> (<span class="ty">Pixel</span> pixel : image)
{
    <span class="cm">// 시작점(origin) = 카메라 위치, 방향(direction) = 카메라에서 픽셀 중심을 지나는 방향</span>
    <span class="ty">Ray</span> ray = <span class="fn">MakeCameraRay</span>(pixel);

    <span class="cm">// 씬의 삼각형 중 ray가 가장 먼저 맞는 것 하나를 찾는다.</span>
    <span class="cm">// 비용의 전부가 이 한 줄이다. 순진하게 짜면 삼각형 전수 검사가 되고, 이걸 줄이는 방법이 01장의 BVH다</span>
    <span class="ty">Hit</span> hit = <span class="fn">FindClosestHit</span>(scene, ray);

    <span class="ty">float3</span> color;
    <span class="kw">if</span> (hit.bIsValid)
        color = <span class="fn">EvalMaterial</span>(hit) * <span class="fn">EvalLighting</span>(hit);   <span class="cm">// 재질(베이스 컬러·거칠기 등) × 도달한 빛</span>
    <span class="kw">else</span>
        color = <span class="fn">SampleSky</span>(ray.direction);                <span class="cm">// miss = ray가 향한 방향의 하늘·환경맵 색</span>

    <span class="fn">WritePixel</span>(pixel, color);                            <span class="cm">// 결과를 프레임 버퍼에 기록</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
이 구조가 강력한 이유는 <strong>Ray를 어디서든, 어느 방향으로든 쏠 수 있다</strong>는 데 있다. 카메라에서만 쏘라는 법이 없다. 히트 지점에서 광원을 향해 하나 더 쏴서 중간에 뭐라도 맞으면 그 지점은 그림자다. 래스터라이제이션이 섀도우 맵·SSR·라이트맵이라는 우회책으로 답해 온 세 질문(그림자·반사·간접광)이 전부 Ray 하나짜리 질문으로 바뀐다: 반사 방향으로 쏘면 화면 밖 물체까지 정확히 비치는 반사가 되고, 표면 위 반구 방향으로 여러 개 쏘면 간접광이 된다. 래스터라이제이션이 효과마다 다른 우회책을 쌓았다면, 레이 트레이싱은 <strong>모든 효과를 "Ray 쏘기" 하나로 통일</strong>한다.
</p>

<span class="section-eyebrow">DXR: 여섯 셰이더 스테이지</span>

<p style="color:var(--text2);line-height:1.85;">
이제 DXR 용어로 옮기자. 01장에서 "트리 하나를 물체 경계에서 자른 두 조각"으로 본 BVH가, 실제 API에서는 <strong>2단계</strong>다. <strong>BLAS</strong>(bottom-level acceleration structure)는 삼각형 메시(또는 프로시저럴 AABB) 하나의 BVH다. <strong>TLAS</strong>(top-level)는 그 BLAS들의 <strong>인스턴스</strong>(변환 행렬 + InstanceID + 마스크 + 플래그)를 다시 묶은 BVH다. 앱은 <code>BuildRaytracingAccelerationStructure()</code>를 호출해 자기 소유의 GPU 메모리에 <strong>불투명(opaque)</strong> 구조를 빌드한다. 내부 포맷은 드라이버와 GPU 제조사(IHV) 소관이라 앱은 들여다보지 못한다. DXR 스펙의 표현 그대로 "bottom-level은 씬을 이루는 building block, top-level은 그 인스턴스들의 집합"이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
Ray를 쏘는 쪽은 <strong>여섯 종류의 셰이더 스테이지</strong>로 돌아간다. <code>DispatchRays()</code>가 <strong>ray generation(raygen, 줄여서 RGS)</strong> 그리드를 기동하고, raygen이 <code>TraceRay()</code>로 Ray를 쏜다. 트래버설 중 BLAS와 교차할 때마다 <strong>any-hit</strong> 셰이더가 호출돼 그 히트를 받아들일지(<code>AcceptHitAndEndSearch</code>) 무시할지(<code>IgnoreHit</code>) 결정한다. 알파 마스킹이 전형적인 용도다. 교차 판정 자체는 프로시저럴 지오메트리면 <strong>intersection</strong> 셰이더가 계산하고, 삼각형이면 하드웨어가 처리한다. 트래버설이 끝나면 <strong>closest-hit</strong>(가장 가까운 승인된 교차) 또는 <strong>miss</strong>(아무것도 못 맞음) 중 하나가 실행된다. 여기에 셰이더에서 서브루틴처럼 부르는 <strong>callable</strong>까지 여섯이다. 이 중 교차 지점에서 도는 셋(closest-hit·any-hit·intersection)은 <strong>hit group</strong>이라는 한 묶음으로 등록된다. Ray가 어떤 물체에 맞으면, 그 물체에 연결된 hit group의 셰이더들이 실행되는 것이다.
</p>

<div class="data-table">
<table>
<tr><th>스테이지</th><th>언제</th><th>역할</th></tr>
<tr><td><strong>ray generation</strong></td><td><code>DispatchRays</code> 그리드마다</td><td>Ray 발사의 시작점. <code>TraceRay</code> 호출, 결과를 UAV<span class="fn-note"><input type="checkbox" id="fn-uav" class="fn-toggle"><label for="fn-uav" class="fn-ref">8</label><span class="fn-body"><strong>UAV(Unordered Access View):</strong> 셰이더가 임의 위치에 읽고 쓸 수 있는 버퍼·텍스처 뷰. 레이 트레이싱은 래스터처럼 렌더 타깃에 출력하지 않고 결과를 UAV에 직접 기록한다.</span></span>에 기록</td></tr>
<tr><td><strong>intersection</strong></td><td>프로시저럴 AABB 교차 시</td><td>커스텀 교차 판정(구·볼륨 등). 삼각형은 불필요(HW 처리)</td></tr>
<tr><td><strong>any-hit</strong></td><td>교차 후보마다</td><td>알파 마스킹·반투명 그림자. <code>IgnoreHit</code>로 트래버설 계속 가능</td></tr>
<tr><td><strong>closest-hit</strong></td><td>최근접 승인 교차 1회</td><td>머티리얼 평가·셰이딩. 결과를 payload(Ray에 실려 다니는 데이터, 09장에서 설명)에 기록</td></tr>
<tr><td><strong>miss</strong></td><td>교차 없음</td><td>환경맵·스카이·"가려지지 않음" 표식</td></tr>
<tr><td><strong>callable</strong></td><td>셰이더가 명시 호출</td><td>라이트 펑션 등 서브루틴 분기</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 여섯 스테이지를 다 쓰는 무거운 경로가 있는가 하면, 파이프라인·SBT(06장의 연결표) 없이 임의의 컴퓨트 셰이더에서 Ray를 쏘는 가벼운 경로도 있다. <strong>inline ray tracing(RayQuery)</strong>이다. <code>TraceRayInline</code>은 hit group을 부르지 않고 CS 안에서 트래버설을 직접 돌린다. 언리얼은 "히트 지점에서 <strong>머티리얼 평가가 필요 없는</strong>" 트레이스, 즉 그림자 가시성이나 Lumen surface cache 샘플링에는 inline을 우선한다. 이 두 갈래(RGS vs inline)는 09장의 셰이더 구조에서 다시 만난다.
</p>

<div class="callout callout-purple">
<div class="callout-title">언리얼의 위치</div>
<p>핵심 명제 하나를 미리 짚어두자. <strong>언리얼은 BVH를 직접 만들지 않는다.</strong> 삼각형을 트리로 나누는 실제 빌드는 드라이버/하드웨어가 하고, 언리얼이 하는 일은 그 빌드를 <strong>"언제, 어떤 우선순위로, 어떤 예산 안에서 요청할지" 스케줄링</strong>하고, 결과 BVH의 <strong>메모리를 관리(compaction·residency)</strong>하고, Ray를 올바른 셰이더로 <strong>라우팅(SBT)</strong>하는 것이다. 빌드 스케줄링·메모리 관리·SBT 라우팅, 이 세 가지가 앞의 02·04·06·07장에서 프레임 순서대로 본 내용 전부다.</p>
</div>

<span class="section-eyebrow">두 층을 지나는 순회</span>

<p style="color:var(--text2);line-height:1.85;">
그럼 Ray 하나는 이 두 층을 어떻게 지나갈까. 좌표계가 다르기 때문에 중간에 변환이 한 번 끼어든다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">1</div><div class="step-name">TLAS 순회</div><div class="step-desc">월드 좌표계에서 인스턴스 box들을 검사</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">2</div><div class="step-name">인스턴스 히트</div><div class="step-desc">참조하는 BLAS 주소와 변환 행렬을 읽는다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">3</div><div class="step-name">역변환</div><div class="step-desc">ray의 origin·direction을 M⁻¹로 로컬 좌표계로</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">4</div><div class="step-name">BLAS 순회</div><div class="step-desc">로컬 공간에서 삼각형까지 내려간다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">5</div><div class="step-name">히트 확정</div><div class="step-desc">거리 t를 다시 월드 기준으로 환산</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
01장에서 "공짜가 아니다"라고 한 대가가 구체적으로 3단계의 <strong>역변환</strong>이다. 물체를 월드 좌표로 미리 펼쳐두면 이 변환은 없앨 수 있지만, 그러면 아래 조각을 공유할 수 없다. 변환 한 번과 트리 재사용을 맞바꾸는 것이고, 모든 하드웨어 레이 트레이싱 API가 후자를 택했다. 그리고 이 변환 덕에 <strong>같은 BLAS가 크기·회전이 다른 인스턴스로 재사용</strong>된다. 나무 1000그루가 각기 다른 방향으로 서 있어도 트리는 한 벌이다.
</p>

<span class="section-eyebrow">두 층을 처리하는 하드웨어</span>

<p style="color:var(--text2);line-height:1.85;">
실무에서 부딪칠 수 있는 부분이 하나 있다. 위에서 BVH가 <strong>"불투명(opaque) 구조"</strong>라 앱이 내부를 들여다볼 수 없다고 했는데, 그 이유가 바로 이 지점이다. <strong>두 층을 실제로 어떤 모양의 트리로 만들고 어떻게 순회하는지가 벤더마다 다르다.</strong> 같은 DXR 코드가 도는 동안 GPU 안에서 벌어지는 일은 NVIDIA와 AMD가 상당히 다르고, 그 차이가 성능 특성과 언리얼의 코드 분기에까지 그대로 나타난다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>NVIDIA RT Core</strong>는 2018년 Turing 세대부터 들어갔다. 특징은 교차 계산뿐 아니라 <strong>BVH 순회 루프 자체가 고정 기능 회로</strong>라는 점이다. 셰이더는 <code>TraceRay</code>를 부르고 결과를 기다리기만 하고, box를 검사해 어느 자식으로 내려갈지 정하고 스택을 관리하는 일 전부가 RT Core 안에서 돌아간다. 세대마다 추가된 것을 정리하면 이렇다.
</p>

<div class="data-table">
<table>
<tr><th>세대</th><th>아키텍처</th><th>추가된 것</th></tr>
<tr><td>1세대</td><td>Turing (2018)</td><td>ray-box·ray-삼각형 교차 + <strong>BVH 순회의 고정 기능화</strong></td></tr>
<tr><td>2세대</td><td>Ampere (2020)</td><td>ray-삼각형 처리량 2배, 모션 블러 전용 가속</td></tr>
<tr><td>3세대</td><td>Ada (2022)</td><td>처리량 2배, <strong>OMM 엔진</strong>(opacity micromap, 알파 테스트 가속), DMM 엔진</td></tr>
<tr><td>4세대</td><td>Blackwell (2025)</td><td>처리량 2배, <strong>Cluster BLAS</strong>(Mega Geometry), linear swept spheres</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>AMD Ray Accelerator</strong>는 RDNA2(2020)부터 CU(compute unit)마다 하나씩 붙는다. 결정적 차이는 <strong>교차 계산만 하드웨어가 하고, 순회 루프는 셰이더가 돈다</strong>는 것이다. <code>image_bvh_intersect_ray</code> 명령이 노드 하나에 대한 ray-box 또는 ray-삼각형 교차를 한 번에 처리해 주지만, 결과를 보고 다음에 어느 자식으로 내려갈지 정해 스택에 넣고 반복하는 코드는 컴파일된 셰이더 안에 있다. 그래서 RT 부하가 CU의 셰이더 자원(레지스터·LDS<span class="fn-note"><input type="checkbox" id="fn-lds" class="fn-toggle"><label for="fn-lds" class="fn-ref">9</label><span class="fn-body"><strong>LDS(Local Data Share):</strong> AMD GPU에서 한 워크그룹의 스레드들이 공유하는 온칩 메모리. NVIDIA의 shared memory에 해당한다.</span></span>)을 함께 먹는다. AMD는 이 구조를 세대마다 하드웨어 쪽으로 밀어 왔다.
</p>

<div class="data-table">
<table>
<tr><th>세대</th><th>추가된 것</th></tr>
<tr><td>RDNA2 (2020)</td><td>Ray Accelerator 도입. <strong>BVH4</strong>(4-wide 노드), ray-box 4개/클럭 · ray-삼각형 1개/클럭. 순회 루프는 셰이더</td></tr>
<tr><td>RDNA3 (2022)</td><td>순회 <strong>스택을 LDS 하드웨어가 관리</strong>(<code>ds_bvh_stack_rtn_b32</code>), box 교차 처리량 향상</td></tr>
<tr><td>RDNA4 (2025)</td><td>교차 엔진 2개로 <strong>box 8개·삼각형 2개/클럭</strong>, <strong>BVH8</strong>(<code>image_bvh8_intersect_ray</code>), 결과 정렬 유닛, 회전된 bounding box(OBB)와 인스턴스 노드 교차까지 하드웨어로</td></tr>
</table>
</div>

<div class="data-table">
<table>
<tr><th>항목</th><th>NVIDIA RT Core</th><th>AMD Ray Accelerator</th><th>Intel RTU</th></tr>
<tr><td>BVH 순회</td><td>고정 기능 하드웨어</td><td>셰이더 루프 (스택은 RDNA3부터 LDS 하드웨어)</td><td>하드웨어 순회 파이프라인 2개</td></tr>
<tr><td>노드 폭</td><td>비공개</td><td>BVH4 → RDNA4에서 BVH8</td><td>비공개</td></tr>
<tr><td>교차 처리량</td><td>세대마다 ray-삼각형 2배씩</td><td>box 4·삼각형 1 → RDNA4에서 8·2</td><td>box 12·삼각형 1 per 클럭</td></tr>
<tr><td>코히런시 장치</td><td>SER (Ada, 셰이더 실행 재정렬)</td><td>교차 결과 정렬 유닛 (RDNA4)</td><td>TSU (thread sorting unit)</td></tr>
</table>
</div>

<div class="callout callout-purple">
<div class="callout-title">이 차이가 언리얼 코드에 남긴 흔적</div>
<p>벤더 차이는 추상적인 이야기가 아니다. 뒤에서 볼 코드 곳곳이 이 차이의 결과다. <strong>①</strong> BLAS 버퍼 크기를 앱이 계산할 수 없어 드라이버에 prebuild 정보를 물어보고, 16비트·32비트 인덱스 두 경우의 큰 쪽으로 잡아두는 처리(07장)는 "노드 포맷이 벤더 소관"이라는 사실의 직접적인 결과다. <strong>②</strong> AMD처럼 순회가 셰이더에서 도는 구조에서는 셰이더 테이블 없이 컴퓨트에서 바로 쏘는 <strong>inline ray tracing</strong>이 자연스럽다. 언리얼이 같은 소스로 RGS와 inline CS 두 경로를 유지하는 이유가 여기 있다(09장). <strong>③</strong> Ada의 OMM 엔진이 가속하는 알파 테스트는, 언리얼이 <code>bForceOpaque</code>로 any-hit 셰이더를 빼서 회피하려는 바로 그 비용이다(06장). 소프트웨어로 우회하던 문제를 하드웨어가 정면으로 푼 셈이다. <strong>④</strong> Blackwell의 Cluster BLAS와 linear swept spheres는 언리얼의 <code>r.RayTracing.Nanite.Mode=2</code>(<code>SupportsClusterOps</code>)와 <code>RTGT_LinearSweptSpheres</code>가 겨냥하는 하드웨어이며, 없으면 fallback proxy 메시로 자동 강등된다(01장).</p>
</div>

<span class="section-eyebrow">09. GPU · 셰이더 코드</span>
</div>

# 셰이더 코드: 한 소스를 두 경로로 컴파일하고, Ray가 들고 다니는 데이터를 64바이트에 맞춘다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
08장의 스테이지는 DXR이 정의한 틀이고, 그 틀 안에서 도는 코드는 언리얼이 쓴다. 이 장은 그 코드가 어떻게 생겼는지다. 엔트리 매크로가 한 소스에서 두 경로를 만드는 법, payload를 몇 바이트에 담는지, <code>TraceRay</code> 래퍼가 어떤 플래그를 기본으로 다는지, hit 셰이더가 지오메트리와 머티리얼에 어떻게 접근하는지 순서다. 06장의 SBT가 "어느 셰이더를 부를지"였다면, 여기는 "불린 셰이더가 무엇을 하는지"다.
</p>
<p style="color:var(--text2);line-height:1.85;">
셰이더 레벨로 내려가면 언리얼의 영리함이 매크로에서 드러난다. <code>RayTracingCommon.ush</code>의 <code>RAY_TRACING_ENTRY_*</code> 매크로가 DXR의 <code>[shader("raygeneration")]</code> 같은 애트리뷰트로 전개되는데, 백미는 <strong><code>RAY_TRACING_ENTRY_RAYGEN_OR_INLINE</code></strong>이다. 이 매크로 하나가 <strong>같은 소스에서 두 개의 엔트리를 생성</strong>한다. inline RayQuery용 컴퓨트 셰이더(<code>nameCS</code>)와 정통 raygen 셰이더(<code>nameRGS</code>)다. 하드웨어가 RayGen 셰이더를 지원하면 RGS를, 지원 안 하고 inline만 되면 CS를 쓴다. 그림자와 Lumen이 이 매크로로 <strong>단일 소스에서 이중 경로</strong>를 유지한다.
</p>

<div class="code-block"><div class="code-lang">HLSL · 개념: 하나의 소스가 두 엔트리로</div><span class="cm">// 이 한 줄이 OcclusionRGS(raygen)와 OcclusionCS(inline) 둘 다 생성</span>
<span class="fn">RAY_TRACING_ENTRY_RAYGEN_OR_INLINE</span>(Occlusion)
{
    <span class="ty">FRayDesc</span> Ray = <span class="fn">CreateShadowRay</span>(...);
    <span class="ty">FMinimalPayload</span> Payload = <span class="fn">TraceVisibilityRay</span>(TLAS, Ray);
    Output[PixelCoord] = Payload.<span class="fn">IsHit</span>() ? <span class="num">0</span> : <span class="num">1</span>;   <span class="cm">// 가려짐/안 가려짐</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>payload</strong>는 raygen과 hit/miss 셰이더가 주고받는 inout 구조체인데, 그 크기가 곧 레지스터 압박이라 언리얼은 여기 공을 들인다. 계층은 이렇다. 가장 가벼운 <code>FMinimalPayload</code>는 <code>float HitT</code> 하나뿐이다(miss면 <code>HitT=-1</code>). 그림자 레이는 "맞았나 안 맞았나"만 알면 되므로 이걸 쓴다. 반대편 극단이 레거시 GBuffer 경로의 <strong><code>FPackedMaterialClosestHitPayload</code></strong>로, radiance·normal·baseColor·metallic·roughness·IOR·ShadingModelID를 fp16으로 비트 패킹해 <strong>정확히 64바이트</strong>에 욱여넣는다. Substrate 경로면 28바이트 고정 + 런타임 계산 데이터로 더 줄인다.
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
payload 타입은 C++ 셰이더 클래스가 <code>GetRayTracingPayloadType()</code>으로 선언하면, 컴파일 시 <code>RT_PAYLOAD_TYPE</code>·<code>RT_PAYLOAD_MAX_SIZE</code> define이 주입되고 <code>CHECK_RT_PAYLOAD_SIZE</code> static assert이 크기를 검증한다. 파이프라인 생성 시 <code>MaxPayloadSizeInBytes</code>로 전달돼 하드웨어가 레지스터를 예약한다. 비트를 아끼려 <strong>입력 플래그와 출력 플래그가 같은 비트를 재사용</strong>하기도 한다. <code>SHADOW_RAY</code>·<code>CAMERA_RAY</code> 같은 입력 플래그와 <code>FRONT_FACE</code> 같은 출력 플래그는 동시에 존재하지 않으니 비트를 겹쳐 쓴다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<code>TraceRay</code>는 목적별 래퍼로 감싸져 있다. <code>TraceVisibilityRay</code>는 그림자용으로 <code>ACCEPT_FIRST_HIT_AND_END_SEARCH | SKIP_CLOSEST_HIT_SHADER</code> 플래그를 달고 SBT 슬롯 <code>SHADOW</code>, minimal payload를 쓴다. 컴퓨트 셰이더에서 호출되면 자동으로 <code>TraceRayInline</code> 경로로 간다. <code>TraceMaterialRay</code>는 슬롯 <code>MATERIAL</code>에 ray cone(텍스처 LOD)까지 실어 보내고 패킹/언패킹을 자동 처리한다.
</p>

<div class="callout callout-info">
<div class="callout-title">ACCEPT_FIRST_HIT: 그림자 레이의 정석</div>
<p>그림자는 "광원까지 가는 길에 <strong>뭐라도 하나 막고 있나</strong>"만 알면 된다. 가장 가까운 교차를 찾을 필요가 없다. 아무거나 하나 맞으면 즉시 "가려짐"이다. <code>RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH</code>가 바로 그 최적화로, 첫 교차에서 트래버설을 끝낸다. NVIDIA 모범 사례가 "가능하면 첫 히트에서 Ray를 종료하라"고 콕 집은 그 플래그이며, 언리얼의 <code>TraceVisibilityRay</code>가 이걸 기본으로 단다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
hit 셰이더 안에서 지오메트리에 접근하려면 로컬 루트 시그니처로 바인딩된 인덱스/정점 버퍼가 필요하다. <code>LoadTriangleBaseAttributes(PrimitiveId)</code>가 16/32비트/논인덱스를 분기해 정점 3개를 로드하고, <code>CalcInterpolants</code>가 버텍스 팩토리 인터폴런트를 barycentric으로 보간하며 <strong>ray cone 기반 텍스처 LOD</strong>까지 계산한다. 머티리얼 CHS는 생성된 <code>Material.ush</code>를 include해 머티리얼 그래프를 평가하고 payload를 패킹한다. 단, 그림자 레이이면서 불투명이면 조기 리턴한다(minimal 모드). AHS는 Masked면 <code>GetMaterialMask()&lt;0 → IgnoreHit()</code>, 반투명 그림자면 <code>ShadowVisibility *= Transparency</code>로 fractional visibility를 누적하며 <code>IgnoreHit()</code>를 반복한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
마지막으로 <strong>deferred materials</strong>라는 코히런시 최적화가 있다. 1차 트레이스에서는 셰이딩을 하지 않고 <strong>SortKey(=hit group UserData)만</strong> 수집한 뒤, 픽셀을 머티리얼별로 정렬하고, 2차 트레이스에서 정렬된 순서로 셰이딩한다. 인접 스레드가 같은 머티리얼 셰이더를 실행하게 만들어 divergence를 줄이는 것이다(AMD는 hit token으로 재트래버설까지 스킵한다). 컴파일은 DXC로 <code>lib_6_6</code>/<code>lib_6_8</code> 타깃, 프리퀀시는 <code>SF_RayGen=6</code>·<code>SF_RayMiss=7</code>·<code>SF_RayHitGroup=8</code>·<code>SF_RayCallable=9</code>다.
</p>

<span class="section-eyebrow">10. 프레임 끝</span>
</div>

# 프레임 끝: GPU가 남긴 기록을 읽어 오고, 임시 상태를 지워 다음 프레임에 넘긴다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
이펙트 패스가 끝나면 남은 일은 셋이다. 첫째, <code>FRayTracingScene::EndFrame</code>이 transient 인스턴스를 리셋하고 미사용 TLAS 버퍼를 해제한다. 둘째, 07장의 compaction이 써낸 압축 크기를 다음 프레임에 리드백해 복사를 이어 간다. 셋째, tracing feedback이 켜져 있으면 이 프레임에 Ray가 실제로 맞은 인스턴스 목록이 다음 프레임 04장의 <code>ScheduleUpdates</code>로 되먹여진다.
</p>
<div class="callout callout-info">
<div class="callout-title">Tracing feedback: 다음 프레임의 빌드를 줄이는 되먹임</div>
<p><code>r.RayTracing.Scene.UseTracingFeedback</code>를 켜면, 셰이더가 실제로 히트한 인스턴스를 UAV에 기록한다(<code>RayTracingFeedback.usf</code>). 다음 프레임엔 이 목록을 참고해 "정말 Ray가 맞는" 동적 지오메트리만 갱신한다(04장). 렌더러가 자기 트레이싱 결과를 되먹여 다음 프레임의 빌드 작업을 줄이는 피드백 루프다. inline 트레이싱 전용이다.</p>
</div>
<p style="color:var(--text2);line-height:1.85;">
그리고 02장의 빌드 큐는 처리되지 못한 요청의 우선순위를 프레임마다 올린 채 다음 프레임을 기다린다. 프레임 순서로 보면 RT 파이프라인은 "준비(01~07장)"와 "사용(08·09장)"의 두 반쪽이고, 준비 쪽 비용의 대부분은 <strong>정점이 변형되는 지오메트리의 수와 크기</strong>에 비례한다. 정점이 바뀌지 않는 메시는 BLAS를 한 번만 빌드하고, 움직여도 매 프레임 TLAS 인스턴스 한 줄만 낸다. 이렇게 준비된 공용 인프라를 여러 이펙트가 어떻게 나눠 쓰는지가 마지막 장이다.
</p>

<span class="section-eyebrow">11. 활용처</span>
</div>

# 활용처: 그림자·Lumen·MegaLights·Path Tracer가 같은 인프라를 나눠 쓴다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
지금까지 만든 BLAS·TLAS·SBT·payload는 특정 효과 전용이 아니다. Ray Traced Shadows, Lumen, MegaLights, Path Tracer가 모두 이 <strong>공유 인프라</strong> 위에서 돌며, 각자 필요한 만큼만 골라 쓴다. 어떻게 나눠 쓰는지가 언리얼 RT 설계의 완성이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>① Ray Traced Shadows.</strong> <code>r.RayTracing.Shadows</code>는 <strong>기본 0</strong>(래스터 섀도우맵이 디폴트)이고, 라이트별로 <code>ECastRayTracedShadow</code>로 켠다. 하드웨어가 RayGen을 지원하면 <code>FOcclusionRGS</code>, 아니고 inline만 되면 <code>FOcclusionCS</code>로 폴백한다. 09장에서 본 <code>RAY_TRACING_ENTRY_RAYGEN_OR_INLINE(Occlusion)</code> 단일 소스가 이 둘을 만든다. <code>TraceVisibilityRay</code>(ACCEPT_FIRST_HIT)로 minimal payload만 주고받고, 결과는 penumbra+거리 3레이아웃으로 디노이저에 넘어간다. 자세한 소프트 섀도우·디노이징은 <a href="/raytracing-shadow">Ray Traced Shadows 글</a>에서 다뤘다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>② Lumen HWRT.</strong> Lumen의 하드웨어 레이 트레이싱(<code>r.Lumen.HardwareRayTracing=1</code>)은 payload를 <strong>이원화</strong>하는 게 핵심이다. 풀 머티리얼(64B) 대신 <strong><code>FLumenMinimalPayload</code></strong>(HitT + 12B: 머티리얼 인덱스·노멀·GPUScene 인스턴스 인덱스)를 쓴다. 히트 지점의 라이팅을 머티리얼 평가가 아니라 <strong>surface cache 샘플링</strong>으로 해결하므로 무거운 머티리얼 payload가 필요 없다. 그래서 뷰마다 <strong>SBT/PSO를 2세트</strong> 둔다: <code>View.MaterialRayTracingData</code>(풀 머티리얼: 그림자·패스트레이서·hit lighting)와 <code>View.LumenRayTracingData</code>(minimal: Lumen·MegaLights). 모드는 <code>LightingMode</code> 0(SurfaceCache)/1(HitLighting)/2(HitLightingForReflections)로 나뉘고, hit lighting 모드는 RGS 필수, surface cache 모드는 inline으로 돈다. 05장에서 본 <strong>FarField TLAS 레이어</strong>가 여기서 원거리 재트레이스에 쓰인다. Lumen 전반은 <a href="/lumen">Lumen 글</a> 참고.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>③ MegaLights.</strong> MegaLights는 그림자 레이를 위해 <strong>Lumen HWRT 인프라를 통째로 재사용</strong>한다. <code>MegaLightsHardwareRayTracing.usf</code>가 <code>LumenHardwareRayTracingCommon.ush</code>를 include하고 <code>TraceLumenMinimalRay(TLAS, FarFieldTLAS, ...)</code>를 호출한다. 즉 Lumen의 minimal payload와 SBT를 그대로 쓴다. 기본 inline RayQuery(<code>r.MegaLights.HardwareRayTracing.Inline=1</code>)이고, 알파 마스크 평가는 <code>EvaluateMaterialMode</code>(0=off/1=AHS/2=retrace)로 조절한다. 반투명 표면 라이팅 확장은 <a href="/megalights">MegaLights 글</a>에서 다뤘다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>④ Path Tracer.</strong> 오프라인 품질을 노리는 Path Tracer(<code>PathTracingMainRG</code>)는 <strong>wavefront 구조</strong>가 특징이다. CAMERA/INNER/TAIL 세 커널 퍼뮤테이션으로 나눠, path state를 <code>StructuredBuffer</code>에 압축 저장하고 활성 경로만 <code>RayTraceDispatchIndirect</code>로 바운스마다 재디스패치한다. 06장에서 본 "재귀 대신 반복" 철학의 극단이다. NEE<span class="fn-note"><input type="checkbox" id="fn-nee" class="fn-toggle"><label for="fn-nee" class="fn-ref">10</label><span class="fn-body"><strong>NEE(Next Event Estimation):</strong> 반사 방향으로 쏜 Ray가 우연히 광원에 닿기를 기다리지 않고, 광원을 직접 골라 그쪽으로 Ray를 쏴 직접광을 샘플링하는 기법.</span></span>(광원 CDF + light grid)로 직접광을 샘플링하고, SER(<code>NvReorderThread</code>, <code>PATH_TRACER_USE_SER</code>)로 셰이더 실행을 재정렬하며, 프레임 간 radiance를 누적한다(BLAS 재빌드가 감지되면 누적 무효화). 같은 <code>RayTracingScene</code>과 풀 머티리얼 SBT를 쓰되 payload는 <code>PathTracingMaterial</code>이고, 컬링은 강제 해제된다. 렌더링 방정식을 오프라인에 굽는 관점은 <a href="/gpu-lightmass">GPU Lightmass 글</a>과 이어진다.
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
표를 세로로 읽으면 언리얼 설계의 요점이 보인다. <strong>payload를 가볍게 유지할 수 있는 시스템(그림자·Lumen·MegaLights)은 minimal payload로 인프라를 공유</strong>하고, 진짜 머티리얼 평가가 필요한 시스템(Path Tracer, Lumen hit lighting)만 풀 머티리얼 SBT/PSO를 별도로 든다. Ray를 쏘는 부품(BLAS·TLAS·TraceRay)은 공용으로 하나이되, 그 위에서 payload와 SBT를 시스템별로 갈아 끼우는 것이다.
</p>

<span class="section-eyebrow">정리</span>
</div>

# 정리

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
언리얼의 레이 트레이싱을 한 문장으로 압축하면 <strong>"하드웨어 가속을 받을 수 있는 BVH 빌드·TraceRay·hit group이라는 기본 부품 위에, 엔진이 '언제 빌드/refit/compaction할지'의 스케줄링과 'Ray를 어떤 셰이더로 보낼지'의 SBT 라우팅, 그리고 '데이터를 몇 바이트에 담을지'의 payload 패킹을 더해, 그 결과물인 공용 인프라를 Shadows·Lumen·MegaLights·Path Tracer가 나눠 쓰게 만든 것"</strong>이다. 언리얼은 BVH를 직접 만들지 않는다. 만들어달라고 요청하는 시점과 방식을 관리할 뿐이다.
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
<div class="card-desc">세그먼트당 레코드 2개(material/shadow), 인스턴스 마스크 8비트, dedup·persistent SBT로 그 악명 높은 인덱스 계산을 관리한다.</div>
</div>
<div class="card gold">
<div class="card-label">payload</div>
<div class="card-title">4B에서 64B까지</div>
<div class="card-desc">그림자는 HitT 하나, Lumen은 12B(surface cache), 레거시 머티리얼은 64B 비트 패킹. 크기가 곧 레지스터 압박.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
숫자로 다시 정리하면 세그먼트당 SBT 슬롯 2개, geometry multiplier 2, 재귀 깊이 1, compaction 문턱 128 프리미티브·배치 64, 컬링 반경 300m·각도 1°, payload 최대 64B, 인스턴스 버퍼 8192 단위·TLAS 버퍼 16MB 단위다. 이 상수들 뒤에는 대부분 DXR 스펙의 제약이나 NVIDIA 모범 사례의 권고가 있다. refit이 트래버설 품질을 갉아먹는다는 스펙 문장이 <code>ForceBuild</code> 카운터로, any-hit이 비싸다는 경고가 <code>bForceOpaque</code>로, "FAST_BUILD도 UPDATE도 없어야 최대 압축"이라는 팁이 <code>ShouldCompactAfterBuild</code> 조건으로 굳었다. 이 인프라 위에서 Ray가 실제로 무슨 일을 하는지는 각 시스템의 이야기다. 그림자를 쏘는 <a href="/raytracing-shadow">Ray Traced Shadows</a>, 간접광을 모으는 <a href="/lumen">Lumen</a>, 렌더링 방정식을 오프라인에 굽는 <a href="/gpu-lightmass">GPU Lightmass</a>로 이어진다.
</p>

<span class="section-eyebrow">참고</span>

<p style="color:var(--text2);line-height:1.85;">
본문의 클레임은 아래 출처와 직접 대조해 확인했다. 각 항목 끝의 괄호는 그 출처가 뒷받침하는 장이다.
</p>

<p style="color:var(--text2);line-height:1.8;font-size:14.5px;margin:0 0 11px;padding-left:2.1em;text-indent:-2.1em;">
[1] <strong>Unreal Engine 5.8 소스</strong>, 로컬 체크아웃(<code>D:\UnrealEngine_5_8</code>). <code>D3D12RHI/Private/D3D12RayTracing.cpp</code>, <code>Renderer/Private/RayTracing/RayTracingScene.{h,cpp}</code>, <code>RayTracingShaderBindingTable.cpp</code>, <code>RayTracingMaterialHitShaders.cpp</code>, <code>RayTracingGeometryManager.cpp</code>, <code>Engine/Shaders/Private/RayTracing/RayTracingCommon.ush</code>, 그리고 활용처의 <code>RayTracingShadows.cpp</code>·<code>LumenHardwareRayTracing*</code>·<code>PathTracing.cpp</code>. 이 글의 모든 클래스·상수·CVar 기본값의 1차 출처다. (01~11장)
</p>

<p style="color:var(--text2);line-height:1.8;font-size:14.5px;margin:0 0 11px;padding-left:2.1em;text-indent:-2.1em;">
[2] Microsoft, <strong>DirectX Raytracing (DXR) Functional Specification</strong>. <a href="https://microsoft.github.io/DirectX-Specs/d3d/Raytracing.html">microsoft.github.io/DirectX-Specs/d3d/Raytracing.html</a>. 2단계 가속 구조, 여섯 셰이더 스테이지, hit group·SBT 레코드 레이아웃과 정렬 규칙, update가 정점 위치만 바꾸고 토폴로지는 못 바꾼다는 제약. (01·04·06·08장)
</p>

<p style="color:var(--text2);line-height:1.8;font-size:14.5px;margin:0 0 11px;padding-left:2.1em;text-indent:-2.1em;">
[3] NVIDIA, <strong>Best Practices: Using NVIDIA RTX Ray Tracing</strong>. <a href="https://developer.nvidia.com/blog/best-practices-using-nvidia-rtx-ray-tracing/">developer.nvidia.com/blog/best-practices-using-nvidia-rtx-ray-tracing</a>. TLAS는 매 프레임 <code>PREFER_FAST_TRACE</code> rebuild, 정적 BLAS는 FAST_TRACE + compaction, refit 반복 시 품질 저하와 주기적 rebuild, any-hit 최소화. (02~07장)
</p>

<p style="color:var(--text2);line-height:1.8;font-size:14.5px;margin:0 0 11px;padding-left:2.1em;text-indent:-2.1em;">
[4] NVIDIA, <strong>Tips: Acceleration Structure Compaction</strong>. <a href="https://developer.nvidia.com/blog/tips-acceleration-structure-compaction/">developer.nvidia.com/blog/tips-acceleration-structure-compaction</a>. 정적 BLAS 메모리 최소 50% 절감, <code>EmitPostbuildInfo</code> → 리드백 → <code>COPY_MODE_COMPACT</code>의 멀티 프레임 절차, FAST_BUILD·ALLOW_UPDATE가 없어야 최대 압축. (07장)
</p>

<p style="color:var(--text2);line-height:1.8;font-size:14.5px;margin:0 0 11px;padding-left:2.1em;text-indent:-2.1em;">
[5] NVIDIA, <strong>RTX Blackwell GPU Architecture</strong>. <a href="https://www.nvidia.com/content/dam/en-zz/Solutions/design-visualization/quadro-product-literature/NVIDIA-RTX-Blackwell-PRO-GPU-Architecture-v1.0.pdf">nvidia.com (PDF)</a>. RT Core 세대별 변화, Cluster BLAS(Mega Geometry), linear swept spheres. (08장)
</p>

<p style="color:var(--text2);line-height:1.8;font-size:14.5px;margin:0 0 11px;padding-left:2.1em;text-indent:-2.1em;">
[6] Chester Lam, <strong>RDNA 4's Raytracing Improvements</strong>, Chips and Cheese. <a href="https://chipsandcheese.com/p/rdna-4s-raytracing-improvements">chipsandcheese.com/p/rdna-4s-raytracing-improvements</a>. AMD 교차 엔진 처리량, BVH4에서 BVH8로의 전환과 <code>image_bvh8_intersect_ray</code>, LDS 순회 스택 명령. (08장)
</p>

<p style="color:var(--text2);line-height:1.8;font-size:14.5px;margin:0 0 11px;padding-left:2.1em;text-indent:-2.1em;">
[7] Intel, <strong>Arc Graphics Developer Guide for Real-Time Ray Tracing</strong>. <a href="https://www.intel.com/content/www/us/en/developer/articles/guide/real-time-ray-tracing-in-games.html">intel.com/content/www/us/en/developer/articles/guide/real-time-ray-tracing-in-games.html</a>. RTU의 순회 파이프라인과 box·삼각형 처리량, Thread Sorting Unit. (08장)
</p>
</div>
