---

layout: post
title: "D3D12 Residency와 DXR SBT: 메모리 주소는 한 번만 써 두고, 사용할 리소스는 매번 다시 알린다 — 작업관리자의 80GB부터 GPU 페이지 폴트까지 UE 5.8 소스로 해부"
icon: paper
permalink: d3d12-residency-sbt
categories: Rendering
tags: [ComputerGraphics, Rendering, D3D12, DirectX12, Residency, WDDM, ShaderBindingTable, SBT, RayTracing, DXR, Bindless, PageFault, UnrealEngine]
excerpt: "작업관리자 GPU 탭에는 이상한 숫자가 있다. '전용 GPU 메모리'는 그래픽카드의 VRAM 크기 그대로인데, 그 옆의 'GPU 메모리'는 80GB처럼 VRAM보다 훨씬 큰 값이 찍힌다. GPU 메모리도 CPU 메모리처럼 가상화되어 있다는 뜻이고, 지금 VRAM에 실제로 올라와 있는 것과 시스템 RAM으로 밀려난 것을 누군가 매 Submit마다 갈라 관리하고 있다는 뜻이다. D3D12에서 그 누군가는 드라이버가 아니라 애플리케이션 자신이다. 이 글은 언리얼엔진 5.8 소스로 그 관리의 전모를 추적한다. 리소스의 GPU 주소가 레이트레이싱 SBT 레코드에 기록되는 순간(한 번)과, 그 주소의 리소스를 '이번 Submit에서 씁니다'라고 residency 매니저에 등록하는 순간(매번)이라는 두 흐름이 이 시스템의 뼈대다. 1,773줄짜리 d3dx12residency.h의 LRU와 grace period(예산 70%부터 60초→1초), 풀 블록(기본 32MiB)이라는 residency의 단위, SBT 레코드 한 줄의 바이트 레이아웃과 bindless 시대의 바인딩 두 경로, TLAS가 대신 등록해 주는 간접 참조들, 그리고 두 흐름이 어긋났을 때 GPU 페이지 폴트가 DRED 덤프에 남기는 시그니처까지. 크래시 덤프의 주소 한 줄을 읽을 수 있게 되는 것이 이 글의 목표다."
back_color: "#ffffff"
img_name: "d3d12-residency-sbt-core-sketch.webp"
toc: false
show: true
new: true
series: -1
index: 33
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - 작업관리자의 "GPU 메모리"가 왜 VRAM보다 큰지, 그 숫자의 정체가 궁금한 분
> - VRAM이 빠듯할 때만 터지는 GPU 크래시(DEVICE_REMOVED)를 겪어 본 분
> - D3D12의 MakeResident/Evict가 실제로 무엇을 하는 API인지 알고 싶은 분
> - 레이트레이싱 셰이더가 자기가 읽을 버텍스 버퍼를 어떻게 찾는지, SBT 레코드 안에 정확히 뭐가 들어 있는지 궁금한 분
> - bindless 시대에 리소스 바인딩이 어디까지 "인덱스 하나"로 줄었는지 코드로 확인하고 싶은 분
> - Aftermath나 DRED 덤프의 페이지 폴트 주소를 리소스 이름으로 역추적하는 언리얼의 장치를 알고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - 작업관리자 "GPU 메모리 80GB"의 계산식(전용 VRAM + 시스템 RAM의 절반)과 WDDM 메모리 가상화의 구조
> - D3D12 residency의 핵심 계약: Evict는 "회수해도 된다"는 허가이고, evict된 주소를 GPU가 읽으면 페이지 폴트라는 것
> - 언리얼이 쓰는 MS 오픈소스 라이브러리 d3dx12residency.h의 세 가지 주요 개념: ManagedObject·ResidencySet·ResidencyManager
> - residency 관리의 단위는 개별 버퍼가 아니라 **풀 블록 전체**(기본 버퍼 풀 32MiB·업로드 힙 4MiB)라는 것, 그리고 그 전파 경로(GetResidencyHandles)
> - SBT 레코드 한 줄의 구성: 셰이더 식별자 32바이트 + 시스템 파라미터 32바이트(Config·IB 오프셋·인덱스/주소 union) + 루트 CBV 주소들
> - 바인딩 두 경로의 실제: bindless에서 레코드에 직접 기록되는 인덱스는 시스템 IB/VB뿐이고, 나머지 인덱스는 유니폼 버퍼의 내용물로 흘러간다는 것
> - `ByteAddressBuffer HitGroupSystemIndexBuffer;` 한 줄이 컴파일러 rewriter에 의해 `ResourceDescriptorHeap[...]` 접근으로 재작성되는 단계
> - Commit이 매번 새 GPU 버퍼를 만들어 SBT 전체를 카피 큐로 재업로드한다는 것, 그리고 persistent 레코드의 stale 구멍
> - 실전 코드 루트: 바인딩 switch의 `SetResourceCollection`이 컬렉션 멤버 전부를 등록에 끌어들이는 코드부터, evict된 블록이 등록이 살아 있는 다음 Submit에서 MakeResident로 되살아나는 왕복 전 과정
> - TLAS가 BLAS·버텍스/인덱스 버퍼의 residency를 대신 등록하는 증분 추적(5.8 신규 최적화)과 refcount 캐시
> - 예산 70%부터 시작되는 트리밍, 60초에서 1초로 줄어드는 유예 시간, aged/budget 두 갈래의 eviction
> - 페이징 완료를 GPU 펜스로 기다리게 하는 구조(CPU는 안 막힌다), 그리고 복구 불능 "catastrophic failure"의 TODO 주석
> - GPU 페이지 폴트가 DRED에 남기는 두 가지 시그니처(활성 리소스 vs 최근 해제)와 언리얼의 3중 역추적 로그

<br>

{% include research-post-style.html %}

<div class="research-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# 개요: 작업관리자의 80GB는 어디서 온 숫자인가

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
작업관리자를 열고 성능 탭의 GPU 항목을 보자. "전용 GPU 메모리"는 그래픽카드에 달린 VRAM 크기 그대로다. 16GB 카드면 16GB. 그런데 그 옆의 <strong>"GPU 메모리"는 80GB</strong> 같은, VRAM보다 몇 배 큰 값이 찍혀 있다. 사이에 있는 "공유 GPU 메모리"가 힌트다. 시스템 RAM이 128GB인 머신이라면 그 절반인 64GB가 공유 GPU 메모리로 잡히고, 16 + 64 = 80GB가 "GPU 메모리"가 된다. GPU가 쓸 수 있는 메모리의 상한이 VRAM이 아니라는 뜻이다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="작업관리자 GPU 탭 모형. 전용 GPU 메모리 16GB, 공유 GPU 메모리 64GB, 합계 GPU 메모리 80GB가 막대로 표시되어 있다">
<rect x="10" y="10" width="740" height="220" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="34" y="44" font-family="Segoe UI, sans-serif" font-size="15" font-weight="700" fill="#2b2f3d">GPU 0 — 작업관리자 · 성능 탭</text>
<text x="34" y="86" font-family="Segoe UI, sans-serif" font-size="13" fill="#4b5563">전용 GPU 메모리 (VRAM)</text>
<rect x="300" y="72" width="420" height="18" rx="4" fill="#eef2f8" stroke="#c9d2e0"/>
<rect x="300" y="72" width="84" height="18" rx="4" fill="#3b82c4"/>
<text x="392" y="86" font-family="Consolas, monospace" font-size="12" fill="#2b2f3d">3.1 / 16.0 GB</text>
<text x="34" y="128" font-family="Segoe UI, sans-serif" font-size="13" fill="#4b5563">공유 GPU 메모리 (시스템 RAM의 절반)</text>
<rect x="300" y="114" width="420" height="18" rx="4" fill="#eef2f8" stroke="#c9d2e0"/>
<rect x="300" y="114" width="20" height="18" rx="4" fill="#2a9d8f"/>
<text x="328" y="128" font-family="Consolas, monospace" font-size="12" fill="#2b2f3d">0.6 / 64.0 GB</text>
<text x="34" y="170" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2b2f3d">GPU 메모리 (합계)</text>
<rect x="300" y="156" width="420" height="18" rx="4" fill="#eef2f8" stroke="#c9d2e0"/>
<rect x="300" y="156" width="104" height="18" rx="4" fill="#d9a441"/>
<text x="412" y="170" font-family="Consolas, monospace" font-size="12" font-weight="700" fill="#2b2f3d">3.7 / 80.0 GB</text>
<text x="34" y="208" font-family="Segoe UI, sans-serif" font-size="12" fill="#8b93a3">GPU가 쓸 수 있는 메모리의 상한은 VRAM(16GB)이 아니라 80GB다. 나머지 64GB는 시스템 RAM에서 온다</text>
</svg>
<div class="scene-cap">작업관리자 GPU 탭 모형. "GPU 메모리 80GB"는 전용 VRAM 16GB에 시스템 RAM의 절반(64GB)을 더한 값이다. GPU 메모리가 가상화되어 있다는 것을 OS가 대놓고 보여주는 숫자다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 80GB가 이 글 전체의 출발점이다. GPU 메모리가 VRAM보다 클 수 있다는 것은, CPU 메모리처럼 <strong>GPU 메모리도 가상화되어 있다</strong>는 뜻이다. GPU가 보는 주소는 가상 주소이고, 그 주소가 가리키는 실체는 지금 VRAM에 있을 수도, 시스템 RAM으로 밀려나 있을 수도 있다. 그리고 여러 앱이 VRAM을 나눠 쓰므로, 내 앱이 쓸 수 있는 몫(예산)은 고정값이 아니라 그때그때 변한다. 어떤 리소스를 VRAM에 올려 두고 어떤 리소스를 내릴지 누군가는 매 순간 결정해야 한다. D3D11까지는 드라이버가 알아서 했다. <strong>D3D12부터는 이 결정이 애플리케이션의 책임이다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
그 결정이 실제로 하는 일은 두 가지다. VRAM이 모자라면 당장 안 쓰는 리소스를 시스템 RAM으로 <strong>내리고</strong>(evict), 다시 써야 할 때 VRAM으로 <strong>올린다</strong>(restore, 01장). 문제는 GPU가 실행 도중에 "이거 없네, 잠깐 올려 주세요"를 할 수 없다는 점이다. 내려가 있는 주소를 읽으면 기다리는 게 아니라 <strong>그 자리에서 죽는다</strong>. 그래서 커맨드리스트를 GPU에 넘기기 <em>전에</em>, 그 안에서 건드릴 리소스가 빠짐없이 VRAM에 올라와 있어야 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그런데 무엇을 건드릴지는 앱만 안다. 그래서 앱이 GPU에 일을 넘길 때마다 <strong>"이번에 쓸 리소스는 이것들입니다"라는 목록을 함께 제출</strong>하는 방식이 된다. 이 글에서 <strong>등록</strong>이라고 부르는 것이 이 목록에 이름을 올리는 일이다. 등록된 리소스는 실행 전에 VRAM으로 올라오고 실행이 끝날 때까지 내려가지 않는다. 반대로 목록에서 빠지면 "아무도 안 쓰는 것"으로 취급되어 언제든 내려갈 수 있다. 그리고 이 등록은 <strong>매번 반복해야 한다</strong>. VRAM 사정이 매 순간 달라지기도 하고, 등록 자체가 "이 리소스는 방금 쓰였다"는 표시라서 등록이 끊긴 것부터 내려가기 때문이다. 이 글에 "등록"이 계속 나오는 이유가 이것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
언리얼엔진의 D3D12 RHI(Rendering Hardware Interface, 언리얼이 D3D12·Vulkan 같은 그래픽 API를 감싸는 공통 계층)는 이 책임을 두 개의 흐름으로 나눠서 진다. 하나는 <strong>데이터 흐름</strong>이다. 리소스의 GPU 가상 주소를 어딘가에 기록하는 흐름인데, 레이트레이싱에서는 그 "어딘가"가 SBT(Shader Binding Table, 셰이더와 리소스 바인딩을 담는 GPU 버퍼, 05장에서 자세히 본다)의 <strong>레코드</strong><span class="fn-note"><input type="checkbox" id="fn-record" class="fn-toggle"><label for="fn-record" class="fn-ref">1</label><span class="fn-body"><strong>레코드(shader record):</strong> DXR 스펙의 공식 용어다. 스펙은 표 자체를 <em>shader table</em>, 그 표를 이루는 항목 하나를 <em>shader record</em>라 부른다. 레코드 하나에는 실행할 셰이더를 가리키는 32바이트 식별자와, 그 셰이더만 쓰는 리소스 바인딩(로컬 루트 시그니처 파라미터)이 함께 들어간다. hit group만 레코드를 갖는 게 아니라 raygen·miss·callable도 각각 자기 구역의 레코드를 갖는다. 구조는 05장에서 자세히 본다.</span></span>다. 주소는 한 번 기록되면 레코드가 살아 있는 한 유효하다고 가정된다. 다른 하나는 <strong>선언 흐름</strong>이다. 그 주소가 가리키는 리소스를 "이번 Submit에서 씁니다"라고 residency 매니저에 매 Submit(완성된 커맨드리스트를 GPU 큐에 넘겨 실행시키는 것, 10장)마다 등록하는 흐름이다. 등록된 리소스는 GPU가 실행하기 전에 VRAM에 올라오고, 등록에서 빠진 리소스는 언제든 VRAM 밖으로 밀려날 수 있다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="버텍스 버퍼의 주소가 SBT 레코드에 한 번 기록되는 데이터 흐름과, 매 Submit마다 residency set에 등록되는 선언 흐름이 GPU에서 만나는 다이어그램">
<defs>
<marker id="ov-ab" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#3b82c4"/></marker>
<marker id="ov-at" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#2a9d8f"/></marker>
<marker id="ov-ar" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#d6304a"/></marker>
</defs>
<rect x="20" y="86" width="150" height="130" rx="8" fill="#f3f6fb" stroke="#2b2f3d" stroke-width="1.5"/>
<text x="34" y="76" font-family="Consolas, monospace" font-size="12" fill="#4b5563">VertexBuffer</text>
<text x="34" y="118" font-family="Consolas, monospace" font-size="11" fill="#2b2f3d">VA 0x2'4000'0000</text>
<rect x="34" y="130" width="122" height="18" rx="3" fill="#d9a441" opacity="0.55"/>
<rect x="34" y="154" width="122" height="18" rx="3" fill="#d9a441" opacity="0.35"/>
<rect x="34" y="178" width="122" height="18" rx="3" fill="#d9a441" opacity="0.2"/>
<path d="M 170 120 C 220 120 210 70 262 66" fill="none" stroke="#3b82c4" stroke-width="2.2" marker-end="url(#ov-ab)"/>
<text x="196" y="46" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#3b82c4">① 데이터 흐름</text>
<text x="196" y="62" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#6b7484">주소를 한 번 기록</text>
<rect x="264" y="46" width="300" height="40" rx="6" fill="#eaf1fb" stroke="#3b82c4" stroke-width="1.5"/>
<text x="276" y="64" font-family="Consolas, monospace" font-size="11" fill="#2b2f3d">SBT Record: [Identifier 32B][VB VA][CBV VA…]</text>
<text x="276" y="79" font-family="Consolas, monospace" font-size="10.5" fill="#6b7484">레코드가 살아있는 한 유효하다고 가정</text>
<path d="M 170 190 C 220 190 210 236 262 240" fill="none" stroke="#2a9d8f" stroke-width="2.2" marker-end="url(#ov-at)"/>
<text x="196" y="262" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2a9d8f">② 선언 흐름</text>
<text x="196" y="278" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#6b7484">매 Submit마다 등록</text>
<rect x="264" y="220" width="300" height="40" rx="6" fill="#e9f6f4" stroke="#2a9d8f" stroke-width="1.5"/>
<text x="276" y="238" font-family="Consolas, monospace" font-size="11" fill="#2b2f3d">ResidencySet.Insert(handle) → MakeResident</text>
<text x="276" y="253" font-family="Consolas, monospace" font-size="10.5" fill="#6b7484">"이번 커맨드리스트에서 이 리소스를 씁니다"</text>
<rect x="620" y="110" width="120" height="86" rx="10" fill="#f3f6fb" stroke="#2b2f3d" stroke-width="2"/>
<text x="680" y="146" font-family="Segoe UI, sans-serif" font-size="15" font-weight="700" fill="#2b2f3d" text-anchor="middle">GPU</text>
<text x="680" y="166" font-family="Consolas, monospace" font-size="10" fill="#6b7484" text-anchor="middle">DispatchRays</text>
<text x="680" y="182" font-family="Consolas, monospace" font-size="10" fill="#6b7484" text-anchor="middle">레코드의 VA를 읽음</text>
<path d="M 564 66 C 600 66 600 116 618 122" fill="none" stroke="#3b82c4" stroke-width="2.2" marker-end="url(#ov-ab)"/>
<path d="M 564 240 C 600 240 600 192 618 186" fill="none" stroke="#2a9d8f" stroke-width="2.2" marker-end="url(#ov-at)"/>
<path d="M 480 88 L 480 148 L 610 148" fill="none" stroke="#d6304a" stroke-width="1.8" stroke-dasharray="5 4" marker-end="url(#ov-ar)"/>
<text x="430" y="168" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#d6304a">②가 빠지면: evict된 주소를 읽음</text>
<text x="430" y="184" font-family="Consolas, monospace" font-size="11" fill="#d6304a">→ GPU PAGE FAULT</text>
</svg>
<div class="scene-cap">이 글이 다루는 전체 그림. 주소는 SBT 레코드에 한 번만 써 두고(①), 그 리소스를 쓴다는 등록은 매 Submit마다 반복한다(②). 크래시는 ①은 살아 있는데 ②가 빠진 리소스에서 난다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
문제는 이 두 흐름이 <strong>완전히 다른 코드 경로</strong>라는 데 있다. 주소를 기록하는 코드가 등록을 보장해 주지 않는다. 레코드에는 주소가 멀쩡히 남아 있는데 어느 프레임부터 등록 목록에서 빠진 리소스가 생기면, VRAM이 넉넉할 때는 아무 일도 없다. evict될 이유가 없으니까. 그런데 VRAM이 예산의 70%를 넘어 압박이 시작되면(10장) 그 리소스는 "아무도 안 쓴다"고 판정되어 VRAM 밖으로 밀려나고, GPU가 레코드의 주소를 읽는 순간 주소 변환이 실패한다. GPU 페이지 폴트, 그리고 <code>DXGI_ERROR_DEVICE_REMOVED</code>다. "잘 돌던 씬이 VRAM 빠듯한 날에만 죽는다"는 미스터리의 정체가 대개 이것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 글은 그 사이의 전 구간을 언리얼엔진 5.8 소스로 따라간다. 순서는 이렇다. GPU 메모리 가상화라는 배경(01장), residency 라이브러리의 구조(02장)를 깔고 나면, 이 모든 코드가 엔진의 어느 스레드에서 어떤 입력 때문에 불리는지를 메시 하나로 따라가는 전체 흐름(03장)이 나온다. 그다음부터는 이 흐름의 단계를 하나씩 확대해서 본다. residency 관리의 단위가 되는 풀 블록(04장), SBT 레코드의 구조(05장)와 주소가 기록되는 두 바인딩 경로(06장), 레코드를 GPU 버퍼로 올려 마무리하는 Commit(07장), 간접 참조를 대신 등록하는 씬 추적(08장), 디스패치 시점의 등록(09장), Submit 시점의 페이징(10장), 그리고 두 흐름이 어긋났을 때의 페이지 폴트와 진단(11장).
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
1차 출처는 언리얼엔진 5.8 소스다. 핵심 파일은 <code>Engine/Source/ThirdParty/Windows/D3DX12/Include/d3dx12residency.h</code>(마이크로소프트의 MIT 라이선스 residency 라이브러리에 Epic이 <code>BEGIN/END EPIC MOD</code> 주석으로 패치를 더한 것, 1,773줄), <code>D3D12RHI/Private</code>의 <code>D3D12RayTracing.cpp</code>(6,933줄)·<code>D3D12Resources.cpp</code>·<code>D3D12PoolAllocator.cpp</code>·<code>D3D12Submission.cpp</code>·<code>D3D12Util.cpp</code>다. 이론 배경은 마이크로소프트의 D3D12 Residency 문서와 DXR 사양을 따른다. 본문의 라인 번호는 모두 이 트리에서 실측한 값이다.
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">01 — 배경: WDDM</span>
</div>

# GPU 메모리도 가상화되어 있다: MakeResident와 Evict의 진짜 의미

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
Windows에서 GPU 메모리를 관리하는 주체는 WDDM(Windows Display Driver Model)의 비디오 메모리 관리자, 줄여서 <strong>VidMm</strong>이다. WDDM 2.0(Windows 10)부터 GPU도 프로세스별 가상 주소 공간을 가진다. 앱이 리소스를 만들면 GPU 가상 주소(GPU VA)가 배정되고, 그 주소가 실제로 VRAM의 어느 물리 페이지를 가리킬지는 VidMm이 페이지 테이블로 관리한다. CPU의 가상 메모리와 똑같은 구조다. 그래서 여러 앱이 각자 VRAM보다 큰 메모리를 할당해 둘 수 있고, 작업관리자의 "GPU 메모리"가 80GB가 될 수 있다. 넘치는 만큼은 시스템 RAM(공유 GPU 메모리)으로 밀려나며, PCIe 너머의 RAM을 GPU가 직접 읽는 것은 VRAM보다 수 배에서 수십 배 느리다.
</p>

<p style="color:var(--text2);line-height:1.85;">
여기서 <strong>residency(상주)</strong>라는 개념이 나온다. 어떤 리소스가 resident라는 것은 "지금 GPU가 접근할 수 있는 메모리에 물리적으로 올라와 있다"는 뜻이다. D3D12는 이 상태를 앱이 직접 제어하는 API 두 개를 준다. <code>ID3D12Device::MakeResident</code>는 "이 리소스들을 GPU가 접근할 수 있게 올려 달라"는 요청이고, <code>ID3D12Device::Evict</code>는 그 반대, 정확히는 <strong>"이 리소스의 자리를 OS가 회수해도 된다"는 허가</strong>다. Evict를 불렀다고 즉시 내려가는 것이 아니라, 다른 앱이나 내 앱의 MakeResident가 자리를 필요로 할 때 VidMm이 그 자리를 가져간다. 반대로 evict된 리소스의 GPU VA를 GPU가 읽으면 페이지 테이블에 유효한 매핑이 없으므로 <strong>페이지 폴트</strong>가 나고, CPU와 달리 GPU의 페이지 폴트는 복구되지 않는다. 디바이스가 통째로 제거된다(11장).
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 310" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GPU 가상 주소 공간의 리소스들이 VRAM과 시스템 RAM에 나뉘어 매핑되는 그림. evict된 리소스는 매핑이 끊겨 있고 GPU가 읽으면 페이지 폴트가 난다">
<defs>
<marker id="wd-a" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#6b7484"/></marker>
<marker id="wd-r" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#d6304a"/></marker>
</defs>
<text x="24" y="30" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2b2f3d">GPU 가상 주소 공간 (프로세스별)</text>
<rect x="24" y="40" width="712" height="46" rx="6" fill="#f3f6fb" stroke="#2b2f3d" stroke-width="1.5"/>
<rect x="40" y="48" width="120" height="30" rx="4" fill="#8fc1ee"/><text x="52" y="67" font-family="Consolas, monospace" font-size="11" fill="#1e3a5f">Texture A</text>
<rect x="180" y="48" width="150" height="30" rx="4" fill="#d9a441"/><text x="192" y="67" font-family="Consolas, monospace" font-size="11" fill="#5c4308">VertexBuffer B</text>
<rect x="350" y="48" width="110" height="30" rx="4" fill="#b9c3d4"/><text x="362" y="67" font-family="Consolas, monospace" font-size="11" fill="#3d4654">Buffer C</text>
<rect x="480" y="48" width="130" height="30" rx="4" fill="#c9b8e8"/><text x="492" y="67" font-family="Consolas, monospace" font-size="11" fill="#443066">TLAS D</text>
<rect x="630" y="48" width="90" height="30" rx="4" fill="#f0b9c2"/><text x="642" y="67" font-family="Consolas, monospace" font-size="11" fill="#6e1f2e">UB E</text>
<rect x="60" y="180" width="300" height="100" rx="8" fill="#eef4fc" stroke="#3b82c4" stroke-width="1.5"/>
<text x="76" y="204" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#3b82c4">VRAM 16GB (전용)</text>
<rect x="76" y="216" width="100" height="26" rx="4" fill="#8fc1ee"/><text x="86" y="233" font-family="Consolas, monospace" font-size="10.5" fill="#1e3a5f">A resident</text>
<rect x="188" y="216" width="120" height="26" rx="4" fill="#d9a441"/><text x="198" y="233" font-family="Consolas, monospace" font-size="10.5" fill="#5c4308">B resident</text>
<rect x="76" y="248" width="110" height="26" rx="4" fill="#c9b8e8"/><text x="86" y="265" font-family="Consolas, monospace" font-size="10.5" fill="#443066">D resident</text>
<rect x="420" y="180" width="300" height="100" rx="8" fill="#f0faf8" stroke="#2a9d8f" stroke-width="1.5"/>
<text x="436" y="204" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2a9d8f">시스템 RAM (공유 64GB)</text>
<rect x="436" y="216" width="100" height="26" rx="4" fill="#b9c3d4"/><text x="446" y="233" font-family="Consolas, monospace" font-size="10.5" fill="#3d4654">C evicted</text>
<rect x="548" y="216" width="90" height="26" rx="4" fill="#f0b9c2"/><text x="558" y="233" font-family="Consolas, monospace" font-size="10.5" fill="#6e1f2e">E evicted</text>
<path d="M 100 86 L 126 178" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#wd-a)"/>
<path d="M 255 86 L 248 214" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#wd-a)"/>
<path d="M 545 86 L 131 246" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#wd-a)"/>
<path d="M 405 86 L 486 214" fill="none" stroke="#9aa4b2" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#wd-a)"/>
<path d="M 675 86 L 593 214" fill="none" stroke="#9aa4b2" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#wd-a)"/>
<text x="24" y="302" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#6b7484">MakeResident = "VRAM에 올려 달라" · Evict = "자리를 회수해도 된다는 허가" · evict된 VA를 GPU가 읽으면 → </text>
<text x="668" y="302" font-family="Consolas, monospace" font-size="11.5" font-weight="700" fill="#d6304a">PAGE FAULT</text>
</svg>
<div class="scene-cap">WDDM의 GPU 메모리 가상화. 가상 주소 공간의 리소스가 VRAM에 매핑되어 있으면 resident, 시스템 RAM으로 밀려나 매핑이 약해지면 evicted다. GPU 입장에서 evict된 주소는 "존재하지 않는 주소"다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
남은 질문은 "그럼 얼마나 올려도 되는가"다. VRAM은 여러 앱이 나눠 쓰므로 내 몫은 고정이 아니다. DXGI가 <code>IDXGIAdapter3::QueryVideoMemoryInfo</code>로 지금 이 순간의 <strong>Budget(예산)</strong>과 CurrentUsage(사용량)를 알려 준다. 예산은 다른 앱이 VRAM을 쓰기 시작하면 줄어들고, 예산을 초과해서 resident로 유지하면 VidMm이 내 리소스를 임의로 페이지아웃하기 시작한다. 어느 것이 내려갈지 내가 고를 수 없게 되는 것이다. 그래서 잘 만든 D3D12 앱의 목표는 이렇게 요약된다. <strong>이번 Submit이 실제로 쓰는 것만 resident로 유지하고, 예산 안에 머물도록 안 쓰는 것을 스스로 골라 내린다.</strong> 이 일을 해 주는 것이 다음 장의 residency 라이브러리다.
</p>

<div class="callout callout-purple">
<div class="callout-title">D3D11과 뭐가 달라졌나</div>
D3D11까지는 드라이버가 매 드로우콜의 바인딩을 다 보고 있었으므로 "이번에 뭐가 쓰이는지"를 드라이버가 알았고, 페이징도 드라이버가 알아서 했다. D3D12는 커맨드리스트(GPU 명령들을 미리 기록해 두는 버퍼)를 미리 기록하고 바인딩은 디스크립터 힙(리소스의 위치와 형식을 적은 작은 기술자들을 모아 둔 테이블) 안의 데이터일 뿐이라 <strong>드라이버가 사용 리소스를 알 방법이 없다</strong>. 그래서 리소스는 기본적으로 생성 시 resident이고, 예산 관리를 하려면 앱이 직접 Evict/MakeResident를 불러야 한다. 참고로 언리얼은 기본 설정(<code>D3D12.ResourcesStartResident=0</code>)에서 한 발 더 나가, 모든 리소스를 <strong>EVICTED 상태로 생성</strong>하고 처음 쓰이는 Submit에서 MakeResident한다(02장).
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">02 — d3dx12residency.h</span>
</div>

# 라이브러리의 세 가지 주요 개념: ManagedObject, ResidencySet, ResidencyManager

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
언리얼은 이 관리를 직접 짜지 않고 마이크로소프트가 공개한 오픈소스 라이브러리를 가져다 쓴다. <code>Engine/Source/ThirdParty/Windows/D3DX12/Include/d3dx12residency.h</code>, 헤더 하나에 1,773줄이 전부인 독립 라이브러리다. Epic이 고친 부분은 <code>BEGIN/END EPIC MOD</code> 주석으로 표시되어 있다. UE 쪽 래퍼는 <code>D3D12RHI/Private/D3D12Residency.h</code>인데 전부 인라인 함수라 별도 cpp조차 없다. 구조를 이해하는 데 필요한 개념은 셋이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
첫째, <strong>ManagedObject</strong>. 추적 대상 하나(정확히는 <code>ID3D12Pageable</code>: 개별 리소스이거나 힙이다. 어느 쪽이 추적 대상이 되는지는 04장에서 갈린다)마다 붙는 메타데이터다.
</p>

<div class="code-block"><div class="code-lang">C++ — d3dx12residency.h:107 (ManagedObject)</div><span class="kw">class</span> <span class="ty">ManagedObject</span>
{
    <span class="kw">enum class</span> RESIDENCY_STATUS { RESIDENT, EVICTED };

    RESIDENCY_STATUS ResidencyStatus;   <span class="cm">// 지금 VRAM에 있나</span>
    <span class="ty">ID3D12Pageable</span>* pUnderlying;        <span class="cm">// 추적 대상 (리소스 또는 힙)</span>
    <span class="kw">UINT64</span> Size;                        <span class="cm">// 바이트 크기</span>
    <span class="kw">UINT64</span> LastGPUSyncPoint;            <span class="cm">// 마지막으로 쓰인 Submit 세대 (GPU가 아직 쓰나 판정)</span>
    <span class="kw">UINT64</span> LastUsedTimestamp;           <span class="cm">// 마지막 사용 시각, QPC 틱 (유예 시간 판정)</span>
    <span class="kw">bool</span>   CommandListsUsedOn[<span class="num">1024</span>];    <span class="cm">// 커맨드리스트별 중복 삽입 방지 플래그</span>
    LIST_ENTRY ListEntry;               <span class="cm">// LRU 침입형 링크드리스트 노드</span>
};</div>

<p style="color:var(--text2);line-height:1.85;">
주목할 것은 "마지막 사용"이 두 필드로 갈라져 있다는 점이다. <code>LastGPUSyncPoint</code>는 Submit 세대 번호로 "GPU가 이걸 아직 쓰고 있을 수 있는가"를 판정하고(쓰는 중이면 evict 금지), <code>LastUsedTimestamp</code>는 <code>QueryPerformanceCounter</code>로 찍은 시각이라 "마지막으로 쓰인 뒤 실제로 몇 초가 흘렀는가"를 재고, 이것이 유예 시간 판정에 쓰인다(10장). 언리얼 쪽에서는 <code>FD3D12ResidencyHandle</code>이 이 클래스를 그대로 상속한 얇은 래퍼다(<code>D3D12Residency.h:46</code>).
</p>

<p style="color:var(--text2);line-height:1.85;">
둘째, <strong>ResidencySet</strong>. 커맨드리스트 하나당 하나씩 붙는 "이번 Submit에서 참조하는 ManagedObject들"의 평면 배열이다. 선언 흐름의 목적지가 바로 이것이다. 흥미로운 건 중복 제거 방식이다. 해시셋이 아니라, 위 구조체의 <code>CommandListsUsedOn[1024]</code> 배열에 슬롯 하나를 마킹하는 <strong>오브젝트 × 커맨드리스트 2차원 bool 매트릭스</strong>다.
</p>

<div class="code-block"><div class="code-lang">C++ — d3dx12residency.h:184 (ResidencySet::Insert)</div><span class="kw">inline bool</span> <span class="ty">Insert</span>(<span class="ty">ManagedObject</span>* pObject)
{
    <span class="cm">// 이 커맨드리스트에서 처음 보는 오브젝트면 마킹하고 배열에 추가</span>
    <span class="kw">if</span> (pObject-&gt;CommandListsUsedOn[CommandListIndex] == <span class="kw">false</span>)
    {
        pObject-&gt;CommandListsUsedOn[CommandListIndex] = <span class="kw">true</span>;
        ppSet[CurrentSetSize++] = pObject;
        <span class="kw">return true</span>;
    }
    <span class="kw">return false</span>;  <span class="cm">// 이미 등록됨 → O(1)로 스킵</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
한 프레임을 그리는 동안 같은 버텍스 버퍼가 드로우콜 수백 개에 바인딩되는 일은 흔하다. 그때마다 등록이 들어오지만 <strong>실제로 목록에 담기는 것은 맨 처음 한 번뿐</strong>이고, 나머지는 전부 걸러진다. residency 매니저 입장에서 필요한 정보는 "이 커맨드리스트가 이 리소스를 쓰는가" 하나뿐이라, 몇 번 쓰는지는 셀 이유가 없기 때문이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
자료구조가 이렇게 생긴 이유도 여기 있다. <code>Insert</code>는 바인딩이 일어날 때마다 불리는 <strong>가장 바쁜 경로</strong>라 한 번 호출이 최대한 싸야 한다. 그래서 중복 판정에 해시 셋이 아니라 <strong>오브젝트가 직접 들고 있는 bool 배열</strong>을 쓴다. <code>CommandListsUsedOn[CommandListIndex]</code>는 해시 계산도 충돌 처리도 없이 <strong>배열 한 칸을 읽는 것으로 끝</strong>이고, 목록 자체는 포인터 평면 배열(<code>ppSet</code>)이라 담는 것도 <code>ppSet[CurrentSetSize++]</code> 한 줄이다. Submit이 나중에 이 목록을 처음부터 끝까지 훑을 때도 평면 배열이 캐시에 가장 유리하다. 대가는 메모리다. 오브젝트마다 1,024칸짜리 bool 배열이 붙어 1KB씩 더 먹는다. 시간을 사고 메모리를 파는 흔한 교환이고, 소스에도 "이 크기는 앱에 맞게 튜닝하라"는 주석이 달려 있다. 그 1,024가 곧 동시에 열려 있을 수 있는 set의 상한이기도 하다. <code>Open()</code>이 1,024개 슬롯 중 빈 것을 하나 예약하고 <code>Close()</code>가 마킹을 지우며 반납한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
셋째, <strong>ResidencyManager</strong>. 디바이스(GPU 노드)당 하나. 예산을 <code>IDXGIAdapter3::QueryVideoMemoryInfo</code>로 <strong>매 Submit마다 실시간 조회</strong>하고, RESIDENT/EVICTED 두 개의 LRU<span class="fn-note"><input type="checkbox" id="fn-lru" class="fn-toggle"><label for="fn-lru" class="fn-ref">2</label><span class="fn-body"><strong>LRU(least recently used):</strong> "가장 오래 안 쓰인 것부터 버린다"는 교체 정책이자, 그 순서를 유지하는 리스트를 가리킨다. 리소스를 쓸 때마다 그 항목을 리스트 머리로 옮기면 꼬리에는 자연히 오래 안 쓰인 것이 모이므로, 메모리가 모자랄 때 꼬리부터 걷어내면 된다. d3dx12residency는 RESIDENT와 EVICTED 두 개를 따로 유지해서 "내릴 후보"와 "되살릴 대상"을 각각 바로 집는다. 링크드리스트 노드를 따로 할당하지 않고 <code>ManagedObject</code> 안에 <code>LIST_ENTRY</code>를 박아 두는 침입형(intrusive) 방식이라, 리스트를 옮기는 데 추가 할당이 들지 않는다.</span></span> 리스트를 유지하며, Submit을 가로채 페이징을 끼워 넣는다(10장). Epic이 더한 <code>LocalMemoryBudgetLimit</code>은 DXGI 예산에 상한을 하나 더 씌우는 값인데, 언리얼이 매 프레임 여기에 값을 넣어 준다. 앱이 포커스를 잃으면 예산을 0으로 만들어 VRAM을 통째로 반납하는 <code>D3D12.EvictAllResidentResourcesInBackground</code>, 예산을 강제로 128MB 따위로 줄여 eviction을 폭주시키는 스트레스 테스트용 <code>D3D12.ResidencyDebugBudgetMB</code>(5.8 신규) 모두 이 값을 통해 동작한다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ResidencyManager가 LRU 리스트와 예산을 들고 있고, 커맨드리스트마다 ResidencySet이 ManagedObject 포인터를 모으는 관계도">
<defs><marker id="lb-a" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#6b7484"/></marker></defs>
<rect x="24" y="24" width="330" height="120" rx="8" fill="#f3f6fb" stroke="#2b2f3d" stroke-width="1.5"/>
<text x="40" y="48" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2b2f3d">ResidencyManager (디바이스당 1개)</text>
<text x="40" y="72" font-family="Consolas, monospace" font-size="11" fill="#3b82c4">RESIDENT LRU: [A]→[B]→[D]→…  (머리=가장 오래됨)</text>
<text x="40" y="94" font-family="Consolas, monospace" font-size="11" fill="#8b93a3">EVICTED  LRU: [C]→[E]→…</text>
<text x="40" y="122" font-family="Consolas, monospace" font-size="11" fill="#b0763a">Budget = QueryVideoMemoryInfo() ← 매 Submit마다</text>
<rect x="420" y="24" width="316" height="120" rx="8" fill="#fdf7ec" stroke="#d9a441" stroke-width="1.5"/>
<text x="436" y="48" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#8a6716">ManagedObject (리소스/힙당 1개)</text>
<text x="436" y="72" font-family="Consolas, monospace" font-size="11" fill="#4b5563">status: RESIDENT | EVICTED</text>
<text x="436" y="92" font-family="Consolas, monospace" font-size="11" fill="#4b5563">LastGPUSyncPoint · LastUsedTimestamp</text>
<text x="436" y="112" font-family="Consolas, monospace" font-size="11" fill="#4b5563">CommandListsUsedOn[1024]</text>
<g>
<rect x="24" y="196" width="330" height="106" rx="8" fill="#e9f6f4" stroke="#2a9d8f" stroke-width="1.5"/>
<text x="40" y="220" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#1e6e64">ResidencySet (커맨드리스트당 1개)</text>
<text x="40" y="244" font-family="Consolas, monospace" font-size="11" fill="#2b2f3d">ppSet: [&amp;A][&amp;B][&amp;D][&amp;TLAS][&amp;SBT]…</text>
<text x="40" y="264" font-family="Consolas, monospace" font-size="11" fill="#6b7484">Open → Insert ×N → Close → Submit으로</text>
<text x="40" y="288" font-family="Consolas, monospace" font-size="11" fill="#6b7484">중복은 bool 매트릭스로 O(1) 스킵</text>
</g>
<g>
<rect x="420" y="196" width="316" height="106" rx="8" fill="#ffffff" stroke="#c9d2e0"/>
<text x="436" y="220" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#4b5563">중복 필터: 오브젝트 × 커맨드리스트 매트릭스</text>
<g font-family="Consolas, monospace" font-size="10" fill="#8b93a3">
<text x="436" y="243">cmdlist →   0  1  2  3 …</text>
</g>
<g>
<rect x="436" y="252" width="16" height="16" fill="#eef2f8" stroke="#c9d2e0"/><rect x="456" y="252" width="16" height="16" fill="#2a9d8f"/><rect x="476" y="252" width="16" height="16" fill="#eef2f8" stroke="#c9d2e0"/><rect x="496" y="252" width="16" height="16" fill="#eef2f8" stroke="#c9d2e0"/>
<rect x="436" y="272" width="16" height="16" fill="#2a9d8f"/><rect x="456" y="272" width="16" height="16" fill="#eef2f8" stroke="#c9d2e0"/><rect x="476" y="272" width="16" height="16" fill="#2a9d8f"/><rect x="496" y="272" width="16" height="16" fill="#eef2f8" stroke="#c9d2e0"/>
</g>
<text x="530" y="266" font-family="Consolas, monospace" font-size="10.5" fill="#6b7484">obj A: cmdlist 1에 등록됨</text>
<text x="530" y="286" font-family="Consolas, monospace" font-size="10.5" fill="#6b7484">obj B: cmdlist 0, 2에 등록됨</text>
</g>
<path d="M 354 84 L 418 84" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#lb-a)"/>
<text x="360" y="76" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7484">LRU로 연결</text>
<path d="M 200 194 L 200 148" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#lb-a)"/>
<text x="208" y="176" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7484">Submit 시 매니저가 set을 소비</text>
</svg>
<div class="scene-cap">세 가지 주요 개념의 관계. ManagedObject는 리소스당 하나, ResidencySet은 커맨드리스트당 하나, ResidencyManager는 디바이스당 하나다. 매니저는 LRU 리스트 두 개(RESIDENT/EVICTED)와 예산을 들고 Submit을 가로챈다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
스레드 모델도 짚어 두자. <code>ID3D12Device3</code>(Windows 10 1709 이상)가 지원하는 <code>EnqueueMakeResident</code>가 있으면 라이브러리는 전용 스레드를 만들지 않는다. 페이징 판단은 Submit 스레드에서 인라인으로 돌고, 실제 페이징의 완료 대기는 GPU 펜스<span class="fn-note"><input type="checkbox" id="fn-fence" class="fn-toggle"><label for="fn-fence" class="fn-ref">3</label><span class="fn-body"><strong>펜스(fence):</strong> GPU 타임라인에 찍는 단조 증가 카운터. "여기까지 실행이 끝났다"를 CPU나 다른 큐가 확인하거나 기다릴 수 있게 하는 D3D12의 기본 동기화 장치다. 이 글에서는 페이징 완료(10장), evict 안전성 판정(10장), 크래시 감지(11장)에 두루 등장한다.</span></span>로 넘긴다(10장). Device3가 없는 구형 OS에서만 자체 워커 스레드를 만들어 블로킹 <code>MakeResident</code>를 대신 부른다. 소프트웨어 큐 깊이는 <code>RESIDENCY_PIPELINE_DEPTH = 6</code>(<code>D3D12RHIDefinitions.h:15</code>), 즉 페이징 처리가 Submit보다 6배치 이상 뒤처지면 Submit 쪽이 기다린다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">03 — 전체 호출 흐름</span>
</div>

# 전체 흐름: 메시 하나가 로드되어 ray에 맞기까지

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
본론의 각 장은 이 시스템을 부품 단위로 하나씩 뜯어본다. 그런데 부품으로 들어가기 전에, 이 코드들이 <strong>엔진의 어느 스레드에서, 어떤 입력 때문에, 어떤 순서로 불리는지</strong>부터 하나의 흐름으로 이어 놓고 시작하자. 레이트레이싱 렌더러를 직접 만지지 않는 클라이언트 프로그래머라도 이 장만 읽으면, 나머지 장들이 전부 이 흐름의 한 단계를 확대한 것임을 알 수 있게 하는 것이 목표다.
</p>

<p style="color:var(--text2);line-height:1.85;">
먼저 등장하는 스레드들이다. 언리얼에서 화면에 뭔가 그려지기까지는 릴레이가 있다. <strong>게임 스레드</strong>가 Tick과 게임플레이 로직을 돌리고(SpawnActor, 레벨 스트리밍이 여기서 시작된다), <strong>렌더 스레드</strong>가 "이번 프레임을 어떤 패스로 어떤 순서로 그릴지" 계획을 세우고, <strong>RHI 스레드</strong>가 그 계획을 실제 D3D12 커맨드리스트로 <strong>옮겨 적고</strong><span class="fn-note"><input type="checkbox" id="fn-translate" class="fn-toggle"><label for="fn-translate" class="fn-ref">4</label><span class="fn-body"><strong>옮겨 적기(translate):</strong> 렌더 스레드는 그래픽 API를 직접 부르지 않는다. 플랫폼과 무관한 <code>FRHICommandList</code>에 "무엇을 하라"는 명령을 <em>기록만</em> 해 둔다. 그 기록을 나중에 플랫폼 컨텍스트에 되짚어 실행해서 진짜 <code>ID3D12GraphicsCommandList</code>로 만드는 단계를 엔진이 translate라 부른다(<code>RHICommandList.h</code>의 <code>FTranslateState</code>, 주석 그대로 "multiple RHICmdLists replayed into it"). 굳이 두 단계로 나누는 이유는 둘이다. 첫째, 렌더러를 RHI 한 벌로만 짜두면 플랫폼마다 각자의 RHI가 자기 API로 옮겨 적으면 된다. 둘째, 네이티브 커맨드리스트 기록은 비싼 작업인데 이 단계는 <code>ETranslatePriority</code>로 여러 태스크 스레드에 흩뿌릴 수 있어(<code>Disabled</code>면 RHI 스레드가 혼자 순차 처리) 렌더 스레드를 붙잡지 않는다. 이 글에서 중요한 건 <strong>옮겨 적는 동안 D3D12 RHI가 그 커맨드리스트가 건드리는 리소스를 ResidencySet에 모아 둔다</strong>는 점이다(09장). Submit이 검사할 목록이 이때 완성된다.</span></span>, <strong>RHI Submit 스레드</strong>가 완성된 커맨드리스트를 GPU 큐에 넘긴다. 이 글의 코드는 대부분 이 릴레이의 RHI 스레드(기록)와 Submit 스레드(페이징) 구간에서 돈다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이제 구체적인 입력 하나를 넣고 끝까지 따라가 보자. <strong>레벨 스트리밍으로 스태틱 메시 하나가 들어온다.</strong> 이 메시의 버텍스 버퍼가 태어나서, 주소가 SBT에 기록되고, 매 프레임 등록되고, VRAM에서 밀려났다가 되살아나고, ray에 맞아 읽히기까지의 전체 과정이다. 중간에 나오는 BLAS/TLAS는 ray와 삼각형의 교차 검사를 빠르게 하기 위한 가속 구조로, BLAS는 메시 하나 단위, TLAS는 그 BLAS들을 씬에 배치한 전체 단위다(08장).
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 430" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="게임 스레드, 렌더 스레드, RHI 스레드, Submit 스레드, GPU 다섯 레인 위에서 메시 로드부터 GPU 실행까지 여덟 단계가 진행되는 전체 호출 흐름. 각 단계에 해당 장 번호가 붙어 있다">
<defs><marker id="fm-a" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#6b7484"/></marker><marker id="fm-r" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#d6304a"/></marker></defs>
<g font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#4b5563">
<text x="10" y="72">게임 스레드</text>
<text x="10" y="142">렌더 스레드</text>
<text x="10" y="212">RHI 스레드</text>
<text x="10" y="282">Submit 스레드</text>
<text x="10" y="352">GPU</text>
</g>
<g stroke="#e2e6ee" stroke-width="1">
<line x1="100" y1="68" x2="748" y2="68"/><line x1="100" y1="138" x2="748" y2="138"/><line x1="100" y1="208" x2="748" y2="208"/><line x1="100" y1="278" x2="748" y2="278"/><line x1="100" y1="348" x2="748" y2="348"/>
</g>
<rect x="106" y="24" width="180" height="16" rx="8" fill="#eef2f8"/><text x="126" y="36" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7484">한 번 (로딩·스트리밍 시)</text>
<rect x="300" y="24" width="448" height="16" rx="8" fill="#e9f6f4"/><text x="470" y="36" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#1e6e64">매 프레임 반복</text>
<line x1="294" y1="20" x2="294" y2="420" stroke="#c9d2e0" stroke-width="1" stroke-dasharray="4 4"/>
<g>
<rect x="108" y="52" width="130" height="32" rx="6" fill="#f3f6fb" stroke="#2b2f3d"/><text x="118" y="66" font-family="Consolas, monospace" font-size="9.5" fill="#2b2f3d">① 메시 스트리밍 인</text><text x="118" y="79" font-family="Consolas, monospace" font-size="9" fill="#8b93a3">SpawnActor·레벨 로드</text>
<rect x="150" y="192" width="136" height="32" rx="6" fill="#fdf7ec" stroke="#d9a441"/><text x="158" y="206" font-family="Consolas, monospace" font-size="9.5" fill="#5c4308">② VB/IB 생성 [04장]</text><text x="158" y="219" font-family="Consolas, monospace" font-size="9" fill="#8a6716">풀 서브할당·EVICTED [02장]</text>
<rect x="306" y="122" width="128" height="32" rx="6" fill="#f3ecfa" stroke="#8b5cf6"/><text x="314" y="136" font-family="Consolas, monospace" font-size="9.5" fill="#443066">③ BLAS/TLAS 빌드</text><text x="314" y="149" font-family="Consolas, monospace" font-size="9" fill="#6b7484">씬 추적 갱신 [08장]</text>
<rect x="444" y="122" width="130" height="32" rx="6" fill="#eaf1fb" stroke="#3b82c4"/><text x="452" y="136" font-family="Consolas, monospace" font-size="9.5" fill="#1e3a5f">④ 바인딩 수집 [06장]</text><text x="452" y="149" font-family="Consolas, monospace" font-size="9" fill="#6b7484">dirty 레코드만</text>
<rect x="444" y="192" width="130" height="32" rx="6" fill="#eaf1fb" stroke="#3b82c4"/><text x="452" y="206" font-family="Consolas, monospace" font-size="9.5" fill="#1e3a5f">⑤ 레코드 기록·Commit</text><text x="452" y="219" font-family="Consolas, monospace" font-size="9" fill="#6b7484">[05·06·07장]</text>
<rect x="584" y="192" width="130" height="32" rx="6" fill="#e9f6f4" stroke="#2a9d8f"/><text x="592" y="206" font-family="Consolas, monospace" font-size="9.5" fill="#1e6e64">⑥ 디스패치 등록 [09장]</text><text x="592" y="219" font-family="Consolas, monospace" font-size="9" fill="#4b8a82">씬+SBT+글로벌+RayGen</text>
<rect x="584" y="262" width="130" height="32" rx="6" fill="#e9f6f4" stroke="#2a9d8f"/><text x="592" y="276" font-family="Consolas, monospace" font-size="9.5" fill="#1e6e64">⑦ 페이징 [10장]</text><text x="592" y="289" font-family="Consolas, monospace" font-size="9" fill="#4b8a82">evict·restore·GPU 게이트</text>
<rect x="584" y="332" width="130" height="32" rx="6" fill="#f3f6fb" stroke="#2b2f3d"/><text x="592" y="346" font-family="Consolas, monospace" font-size="9.5" fill="#2b2f3d">⑧ DispatchRays [11장]</text><text x="592" y="359" font-family="Consolas, monospace" font-size="9" fill="#8b93a3">레코드의 주소를 읽음</text>
</g>
<path d="M 173 84 L 200 190" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#fm-a)"/>
<path d="M 286 208 L 340 156" fill="none" stroke="#6b7484" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#fm-a)"/>
<path d="M 434 138 L 442 138" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#fm-a)"/>
<path d="M 509 154 L 509 190" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#fm-a)"/>
<path d="M 574 208 L 582 208" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#fm-a)"/>
<path d="M 649 224 L 649 260" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#fm-a)"/>
<path d="M 649 294 L 649 330" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#fm-a)"/>
<path d="M 714 278 C 744 278 744 240 714 226" fill="none" stroke="#d6304a" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#fm-r)"/>
<text x="306" y="396" font-family="Segoe UI, sans-serif" font-size="11" fill="#a3243a">빨간 화살표: ⑦에서 예산 압박으로 evict된 블록도, 다음 프레임 ⑥의 등록이 살아 있으면</text>
<text x="306" y="412" font-family="Segoe UI, sans-serif" font-size="11" fill="#a3243a">⑦의 ProcessPagingWork가 EVICTED를 발견하고 MakeResident로 되살린다 (restore)</text>
<text x="108" y="396" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7484">②는 로딩 이벤트라 프레임</text>
<text x="108" y="412" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7484">루프 밖에서 일어난다</text>
</svg>
<div class="scene-cap">이 글 전체의 흐름. 왼쪽 구역(①②)은 리소스 수명 이벤트라 로딩·스트리밍 때 한 번, 오른쪽 구역(③~⑧)은 매 프레임 반복된다. 각 단계를 확대한 것이 대괄호 안의 장이다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
같은 흐름을 실제 함수 이름으로 펼치면 이렇다. 각 행이 곧 이 글의 장 하나에 대응한다.
</p>

<div class="data-table">
<table>
<tr><th>단계</th><th>트리거(입력)</th><th>스레드</th><th>실제 호출 체인</th><th>장</th></tr>
<tr><td>① 로드</td><td>레벨 스트리밍·SpawnActor</td><td>게임→로딩</td><td>UStaticMesh 로드 → 렌더 데이터 초기화</td><td>배경</td></tr>
<tr><td>② 버퍼 생성</td><td>렌더 리소스 초기화</td><td>렌더/RHI</td><td><code>RHICreateBuffer</code> → <code>FD3D12PoolAllocator::AllocateResource</code> → 32MiB 블록 서브할당, <code>BeginTrackingResidency</code>로 EVICTED 등록</td><td>02·04</td></tr>
<tr><td>③ 가속 구조</td><td>씬 렌더링 초입</td><td>렌더→RHI</td><td>BLAS/TLAS 빌드 → <code>PrepareAccelerationStructureBuild</code> → <code>UpdateResidencyTracking</code>(refcount 캐시 증분 갱신)</td><td>08</td></tr>
<tr><td>④ 바인딩 수집</td><td>dirty 레코드 발생</td><td>렌더(태스크)</td><td><code>BindRayTracingMaterialPipeline</code> → <code>MergeAndSetRayTracingBindings</code></td><td>06</td></tr>
<tr><td>⑤ 레코드 기록</td><td>④의 커맨드 실행</td><td>RHI</td><td><code>RHISetBindingsOnShaderBindingTable</code> → <code>SetRayTracingHitGroup</code> → <code>SetRayTracingShaderResources</code>(주소를 레코드에 기록 + 참조 수집) → <code>CommitShaderBindingTable</code>(GPU 업로드)</td><td>05·06·07</td></tr>
<tr><td>⑥ 디스패치 등록</td><td>RT 패스 실행(섀도·Lumen·리플렉션)</td><td>RHI</td><td><code>RHIRayTraceDispatch</code> → <code>DispatchRays</code>: 글로벌+씬+SBT+RayGen 네 갈래 <code>UpdateResidency</code> → ResidencySet</td><td>09</td></tr>
<tr><td>⑦ 페이징</td><td>커맨드리스트 Submit</td><td>Submit</td><td><code>FD3D12Queue::ExecuteCommandLists</code> → <code>ResidencyManager::ExecuteCommandLists</code> → <code>ProcessPagingWork</code>: EVICTED면 MakeResident(restore), 예산 70% 초과면 trim(evict)</td><td>10</td></tr>
<tr><td>⑧ GPU 실행</td><td>페이징 펜스 시그널</td><td>GPU</td><td>큐가 펜스 Wait 통과 → <code>DispatchRays</code> 실행 → 레코드의 VA/인덱스로 버퍼 읽기</td><td>11</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 여덟 단계 안에서 데이터 흐름과 선언 흐름이 각각 어디를 지나는지 표시해 두자. <strong>데이터 흐름(주소 기록)은 ⑤ 한 곳</strong>이다. ②에서 태어난 버퍼의 GPU 주소가 ⑤에서 SBT 레코드에 기록되고, 그 뒤로는 리소스가 이사(rename)하지 않는 한 다시 쓰이지 않는다. <strong>선언 흐름(residency 등록)은 ③⑥⑦에 걸쳐</strong> 있다. ③이 "무엇을 등록해야 하는지" 목록을 캐시해 두면, ⑥이 매 디스패치마다 그 목록을 커맨드리스트의 ResidencySet에 붓고, ⑦이 그 등록을 근거로 VRAM 상태를 실제로 맞춘다. evict와 restore는 전부 ⑦ 안에서 일어나며, 렌더러나 게임 코드는 관여하지 않는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 이 시스템이 흔들리는 지점도 이 단계들 위에 정확히 찍힌다. ⑤는 살아 있는데(레코드에 주소가 남아 있는데) ③이나 ⑥의 목록에서 빠진 리소스가 생기면, ⑦은 그 리소스를 지켜 줄 근거가 없다. VRAM이 넉넉한 동안은 evict될 일이 없어 아무 증상이 없다가, 예산 70%를 넘는 순간 ⑦이 그 블록을 내리고, ⑧에서 GPU가 레코드의 주소를 읽다 페이지 폴트가 난다. 이제 각 단계를 하나씩 확대해 보자.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">04 — 리소스와 풀</span>
</div>

# residency의 단위는 버퍼가 아니라 블록이다

<div class="research-post">
<div class="callout callout-info">
<div class="callout-title">언제 불리나: 전체 흐름의 ②</div>
이 장의 코드는 프레임 루프가 아니라 리소스 수명 이벤트에서 돈다. 레벨 스트리밍이나 에셋 로딩이 렌더 리소스를 초기화하며 <code>RHICreateBuffer</code>를 부르면, <code>FD3D12PoolAllocator</code>가 여기서 다루는 분기(풀이냐 committed냐)를 타고, 그 결과로 02장의 EVICTED 등록까지 한 번에 일어난다.
</div>

<p style="color:var(--text2);line-height:1.85;">
그럼 ManagedObject는 리소스마다 하나씩 붙는가? 아니다. 여기가 눈에 잘 띄지 않지만 이 시스템에서 가장 중요한 대목이다. 언리얼은 버퍼를 하나하나 <code>ID3D12Resource</code>로 만들지 않는다. Windows의 기본 버퍼 경로는 <code>FD3D12PoolAllocator</code>인데, <strong>16MiB 이하</strong>의 버퍼는 <strong>32MiB짜리 풀 블록</strong>에서 잘라 쓴다(<code>BUFFER_POOL_DEFAULT_POOL_SIZE</code>, <code>D3D12Allocation.cpp:32</code>). 서브할당 전략은 둘이다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12PoolAllocator.cpp:231 (서브할당 전략 분기)</div><span class="cm">// 256B 초과 정렬 요구 → placed. UAV(셰이더가 결과를 쓰는 버퍼)처럼 상태 전환이 필요한 것도 placed.</span>
<span class="cm">// 읽기 전용(VB/IB/SRV 버퍼)은 큰 버퍼 하나에서 오프셋만 나눠 갖는다.</span>
<span class="kw">return</span> (ResourceStateMode == MultiState)
    ? EResourceAllocationStrategy::kPlacedResource      <span class="cm">// 블록 = ID3D12Heap + CreatePlacedResource</span>
    : EResourceAllocationStrategy::kManualSubAllocation; <span class="cm">// 블록 = 큰 ID3D12Resource 버퍼 + 오프셋</span></div>

<div class="data-table">
<table>
<tr><th>풀</th><th>블록 크기</th><th>풀 대상 최대 할당</th><th>출처</th></tr>
<tr><td><strong>VRAM 기본 버퍼 풀</strong></td><td><strong>32 MiB</strong></td><td><strong>16 MiB</strong></td><td>D3D12Allocation.cpp:32</td></tr>
<tr><td>레이트레이싱 AS(BLAS/TLAS) 전용 풀</td><td>32 MiB</td><td>16 MiB</td><td>D3D12Allocation.cpp:40</td></tr>
<tr><td>업로드 힙 SmallBlock</td><td>4 MiB</td><td>64 KiB</td><td>D3D12Allocation.cpp:107</td></tr>
<tr><td>READBACK 버퍼 풀</td><td>4 MiB</td><td>64 KiB</td><td>D3D12RHIDefinitions.h:73</td></tr>
<tr><td>읽기 전용 텍스처 VRAM 풀</td><td>64 MiB</td><td>64 MiB</td><td>D3D12Allocation.cpp:64</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
용어를 정리하고 가자. D3D12에서 리소스가 메모리를 얻는 방식은 셋이다. <strong>committed</strong>는 리소스를 만들 때 전용 메모리도 함께 받는 방식, <strong>placed</strong>는 미리 만들어 둔 큰 힙 위의 지정한 오프셋에 리소스를 얹는 방식, <strong>reserved</strong>는 가상 주소만 예약해 두고 물리 메모리는 나중에 타일 단위로 붙이는 방식이다. 위 코드의 kPlacedResource 전략이 placed를 쓰고, kManualSubAllocation은 큰 committed 버퍼 하나를 오프셋으로 나눠 쓰는 변형이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
residency 추적은 이 할당 구조를 그대로 따라간다. committed 리소스(풀에 못 들어가는 큰 것)는 자기가 직접 ManagedObject를 가진다(<code>FD3D12Resource::StartTrackingForResidency</code>, <code>D3D12Resources.cpp:625</code>). 반면 풀에서 잘라 쓴 리소스는 자기 핸들이 없고, <strong>블록(힙 또는 백킹 버퍼)의 핸들 하나를 공유</strong>한다. 전파 경로가 코드 한 곳에 모여 있다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12Resources.h:400 (GetResidencyHandles)</div><span class="ty">TConstArrayView</span>&lt;<span class="ty">FD3D12ResidencyHandle</span>*&gt; <span class="ty">GetResidencyHandles</span>() <span class="kw">const</span>
{
    <span class="kw">if</span> (!bRequiresResidencyTracking)  <span class="kw">return</span> {};
    <span class="kw">else if</span> (IsPlacedResource())      <span class="kw">return</span> Heap-&gt;GetResidencyHandles();           <span class="cm">// 힙의 핸들 1개</span>
    <span class="kw">else if</span> (IsReservedResource())    <span class="kw">return</span> ReservedResourceData-&gt;ResidencyHandles; <span class="cm">// 백킹 힙 N개</span>
    <span class="kw">else</span>                              <span class="kw">return</span> MakeArrayView(&amp;ResidencyHandle, <span class="num">1</span>);     <span class="cm">// committed 자신</span>
}</div>

<div class="scene-fig">
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="32MiB 풀 블록 안에 여러 버퍼가 서브할당되어 있고 residency 핸들은 블록에 하나뿐이다. 버퍼 하나만 써도 블록 전체가 올라오고, 블록이 evict되면 안의 버퍼 전부가 내려간다">
<defs><marker id="pl-a" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#6b7484"/></marker></defs>
<rect x="24" y="40" width="380" height="200" rx="10" fill="#f3f6fb" stroke="#2b2f3d" stroke-width="1.8"/>
<text x="40" y="30" font-family="Consolas, monospace" font-size="12" fill="#4b5563">32 MiB Pool Block (ID3D12Heap / 큰 버퍼 하나)</text>
<rect x="40" y="60" width="100" height="40" rx="5" fill="#8fc1ee"/><text x="50" y="84" font-family="Consolas, monospace" font-size="10.5" fill="#1e3a5f">VB 메시A</text>
<rect x="148" y="60" width="70" height="40" rx="5" fill="#d9a441"/><text x="156" y="84" font-family="Consolas, monospace" font-size="10.5" fill="#5c4308">IB 메시A</text>
<rect x="226" y="60" width="120" height="40" rx="5" fill="#c9b8e8"/><text x="236" y="84" font-family="Consolas, monospace" font-size="10.5" fill="#443066">VB 메시B</text>
<rect x="40" y="110" width="150" height="40" rx="5" fill="#a8d5c2"/><text x="50" y="134" font-family="Consolas, monospace" font-size="10.5" fill="#1e5c46">스킨 버퍼</text>
<rect x="198" y="110" width="90" height="40" rx="5" fill="#f0b9c2"/><text x="208" y="134" font-family="Consolas, monospace" font-size="10.5" fill="#6e1f2e">UB 풀</text>
<rect x="296" y="110" width="90" height="40" rx="5" fill="#e6e9f0" stroke="#c9d2e0"/><text x="306" y="134" font-family="Consolas, monospace" font-size="10.5" fill="#8b93a3">(빈 공간)</text>
<rect x="40" y="160" width="346" height="40" rx="5" fill="#e6e9f0" stroke="#c9d2e0"/><text x="50" y="184" font-family="Consolas, monospace" font-size="10.5" fill="#8b93a3">…</text>
<rect x="40" y="208" width="220" height="22" rx="11" fill="#2b2f3d"/>
<text x="52" y="223" font-family="Consolas, monospace" font-size="11" fill="#ffffff">ResidencyHandle — 블록에 1개</text>
<g>
<rect x="452" y="46" width="284" height="86" rx="8" fill="#e9f6f4" stroke="#2a9d8f" stroke-width="1.5"/>
<text x="468" y="72" font-family="Segoe UI, sans-serif" font-size="12.5" font-weight="700" fill="#1e6e64">VB 메시A 하나만 등록해도</text>
<text x="468" y="94" font-family="Segoe UI, sans-serif" font-size="12" fill="#2b2f3d">MakeResident 단위는 블록 전체.</text>
<text x="468" y="114" font-family="Segoe UI, sans-serif" font-size="12" fill="#2b2f3d">32MiB가 통째로 VRAM에 올라온다</text>
</g>
<g>
<rect x="452" y="152" width="284" height="86" rx="8" fill="#fdeef0" stroke="#d6304a" stroke-width="1.5"/>
<text x="468" y="178" font-family="Segoe UI, sans-serif" font-size="12.5" font-weight="700" fill="#a3243a">블록이 evict되면</text>
<text x="468" y="200" font-family="Segoe UI, sans-serif" font-size="12" fill="#2b2f3d">안의 버퍼 전부가 함께 접근 불가.</text>
<text x="468" y="220" font-family="Segoe UI, sans-serif" font-size="12" fill="#2b2f3d">"안 쓰던 남의 버퍼" 때문에 같이 산다/죽는다</text>
</g>
<path d="M 406 89 L 450 89" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#pl-a)"/>
<path d="M 406 195 L 450 195" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#pl-a)"/>
<text x="24" y="278" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#6b7484">GetResidencyHandles(): placed → 힙 핸들 · 서브할당 → 백킹 버퍼 핸들 · committed → 자기 핸들. 어느 쪽이든 단위는 블록이다.</text>
</svg>
<div class="scene-cap">residency 관리의 실제 단위. 버퍼 수백 개가 블록 하나의 핸들을 공유하므로, MakeResident도 Evict도 언제나 블록 단위로 일어난다. 08장의 씬 추적이 "residency handle 기준 중복 제거"를 하는 이유이기도 하다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 구조가 가져오는 결과는 두 가지다. 좋은 쪽으로는, 등록 비용이 준다. 같은 블록의 버퍼 100개를 쓰면 등록할 핸들은 1개다. 나쁜 쪽으로는, 격리가 없어진다. 내 버퍼가 안 쓰이는 동안에도 같은 블록의 남의 버퍼가 쓰이면 블록은 살아 있고, 반대로 블록이 evict되는 순간 내 버퍼도 예고 없이 함께 내려간다. 추적에서 제외되는 것들도 있다. 백버퍼와 외부 공유 리소스는 커맨드리스트 밖(Present, 서드파티 코드)에서 참조되어 펜스 기반 판정이 틀어지므로 아예 추적하지 않는다(<code>D3D12Resources.cpp:142</code>). 레이트레이싱 가속 구조는 전용 32MiB 풀을 따로 쓰며, 풀 힙에 <code>D3D12_RESIDENCY_PRIORITY_HIGH</code>를 걸어 VidMm의 임의 페이지아웃 우선순위에서도 뒤로 밀리게 한다(<code>D3D12PoolAllocator.cpp:144</code>).
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">05 — SBT 레코드</span>
</div>

# SBT 레코드의 구조: 셰이더는 자기가 읽을 버퍼를 어떻게 아는가

<div class="research-post">
<div class="callout callout-info">
<div class="callout-title">언제 불리나: 생성은 씬 준비 때, 기록은 전체 흐름의 ⑤</div>
SBT 오브젝트 자체는 렌더러가 씬을 준비할 때 만들어지고, 레코드 수는 씬의 지오메트리 세그먼트(메시 안에서 머티리얼별로 나뉜 구간) 수로 결정된다. 이 장이 다루는 레코드 레이아웃을 실제로 채우는 것은 전체 흐름의 ⑤, 즉 06장의 바인딩 코드다.
</div>

<p style="color:var(--text2);line-height:1.85;">
이제 데이터 흐름 쪽으로 넘어가자. 래스터 파이프라인에서는 드로우콜 하나에 셰이더 하나가 묶이니 "지금 어떤 셰이더에 어떤 리소스"인지가 자명하다. 레이트레이싱은 다르다. <code>DispatchRays</code> 한 번에 ray 수백만 개가 나가고, 각 ray는 씬의 <strong>어떤 물체에 맞을지 미리 알 수 없다</strong>. 유리에 맞으면 유리 셰이더가, 나뭇잎에 맞으면 알파 테스트가 있는 셰이더가 돌아야 하고, 각자 자기 머티리얼 텍스처와 자기 지오메트리의 버텍스 버퍼를 읽어야 한다. 그래서 DXR은 "맞을 수 있는 모든 경우"에 대해 <strong>셰이더 + 그 셰이더가 쓸 리소스</strong>를 한 줄씩 미리 적어 둔 표를 요구한다. 이것이 SBT(Shader Binding Table)다. GPU는 히트 지점의 인스턴스/지오메트리 정보로 표의 줄 번호를 계산해서 그 줄에 적힌 셰이더를 실행한다. 표에 들어가는 셰이더는 세 종류다. ray가 무언가에 맞았을 때 도는 <strong>히트그룹</strong>(hit group), 끝까지 아무것도 맞지 않았을 때 도는 <strong>미스</strong>(miss), 필요할 때 표에서 직접 골라 부르는 <strong>콜러블</strong>(callable). ray를 처음 쏘아 보내는 진입점인 <strong>raygen</strong>은 표의 본체와 별도로 다룬다. 레이트레이싱 파이프라인 전반은 <a href="/raytracing-shader">이전 글</a>에서 다뤘고, 여기서는 그 표의 <strong>한 줄(레코드)</strong>을 바이트 단위로 연다.
</p>

<p style="color:var(--text2);line-height:1.85;">
언리얼의 구현 클래스는 <code>FD3D12RayTracingShaderBindingTableInternal</code>(<code>D3D12RayTracing.cpp:1350</code>)이다. 레코드 하나는 <strong>셰이더 식별자 32바이트 + 로컬 루트 시그니처 파라미터 영역</strong>으로 구성된다. 셰이더 식별자는 드라이버가 파이프라인 컴파일 때 발급하는 불투명한 32바이트 토큰으로, "이 줄에서 어떤 셰이더를 실행할지"를 가리킨다. 그 뒤 파라미터 영역의 레이아웃은 로컬 루트 시그니처(레코드에서 값을 읽는 셰이더별 파라미터 목록. 이 단어 자체가 낯설다면 06장 초입에서 설명한다)가 정한다. 레코드 폭은 전체 파이프라인에서 가장 큰 로컬 바인딩 크기 기준으로 32바이트 정렬해 통일한다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12RayTracing.cpp:1439 (레코드 stride 계산)</div>checkf(Initializer.LocalBindingDataSize &gt;= <span class="kw">sizeof</span>(<span class="ty">FD3D12HitGroupSystemParameters</span>),
    TEXT(<span class="num">"All local root signatures are expected to contain ray tracing system root parameters"</span>));

LocalRecordSizeUnaligned = ShaderIdentifierSize + Initializer.LocalBindingDataSize;  <span class="cm">// 32 + α</span>
LocalRecordStride = RoundUpToNextMultiple(LocalRecordSizeUnaligned,
                                          D3D12_RAYTRACING_SHADER_RECORD_BYTE_ALIGNMENT); <span class="cm">// 32B 정렬</span></div>

<p style="color:var(--text2);line-height:1.85;">
위 <code>checkf</code>가 말해 주듯, 모든 히트그룹 레코드의 파라미터 영역은 <strong>시스템 파라미터 32바이트로 시작</strong>한다. 이 32바이트가 "셰이더가 자기 지오메트리의 버텍스/인덱스 버퍼를 찾는 방법"의 전부다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12RayTracingResources.h:18 (FD3D12HitGroupSystemParameters)</div><span class="kw">struct</span> <span class="ty">FD3D12HitGroupSystemParameters</span>
{
    <span class="ty">FHitGroupSystemRootConstants</span> RootConstants;  <span class="cm">// 16B: Config(스트라이드) · IB오프셋 · FirstPrimitive · UserData</span>
    <span class="kw">union</span>
    {
        <span class="kw">struct</span> {  <span class="cm">// bindless 모드: 디스크립터 힙 인덱스 (4B × 2)</span>
            <span class="kw">uint32</span> BindlessHitGroupSystemIndexBuffer;
            <span class="kw">uint32</span> BindlessHitGroupSystemVertexBuffer;
        };
        <span class="kw">struct</span> {  <span class="cm">// 비-bindless 모드: GPU 가상 주소 (8B × 2)</span>
            <span class="ty">FD3D12_GPU_VIRTUAL_ADDRESS</span> IndexBuffer;
            <span class="ty">FD3D12_GPU_VIRTUAL_ADDRESS</span> VertexBuffer;
        };
    };
};</div>

<div class="scene-fig">
<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="SBT 버퍼의 서브테이블 배치와 레코드 한 줄의 바이트 레이아웃. 레코드는 식별자 32바이트, 시스템 파라미터 32바이트, 루트 CBV 주소들로 구성된다">
<text x="24" y="28" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2b2f3d">SBT 버퍼 하나의 배치 (stride는 전 레코드 공통)</text>
<rect x="24" y="40" width="500" height="44" rx="6" fill="#eaf1fb" stroke="#3b82c4" stroke-width="1.5"/>
<text x="36" y="67" font-family="Consolas, monospace" font-size="11" fill="#2b2f3d">HitGroup 레코드 × (세그먼트 수 × 2슬롯)</text>
<rect x="532" y="40" width="90" height="44" rx="6" fill="#f3ecfa" stroke="#8b5cf6" stroke-width="1.5"/>
<text x="542" y="67" font-family="Consolas, monospace" font-size="11" fill="#443066">Callable</text>
<rect x="630" y="40" width="106" height="44" rx="6" fill="#fdf7ec" stroke="#d9a441" stroke-width="1.5"/>
<text x="640" y="67" font-family="Consolas, monospace" font-size="11" fill="#5c4308">Miss</text>
<rect x="24" y="96" width="180" height="30" rx="6" fill="#f0faf8" stroke="#2a9d8f" stroke-width="1.2" stroke-dasharray="4 3"/>
<text x="36" y="116" font-family="Consolas, monospace" font-size="10.5" fill="#1e6e64">RayGen: 디스패치마다 별도 임시 업로드</text>
<text x="24" y="164" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2b2f3d">히트그룹 레코드 한 줄 (바이트 눈금)</text>
<g font-family="Consolas, monospace" font-size="10" fill="#8b93a3">
<text x="24" y="186">0</text><text x="204" y="186">32</text><text x="298" y="186">48</text><text x="384" y="186">56</text><text x="470" y="186">64</text><text x="620" y="186">64+8N</text>
</g>
<rect x="24" y="192" width="184" height="52" rx="4" fill="#dfe9f7" stroke="#3b82c4" stroke-width="1.5"/>
<text x="36" y="214" font-family="Consolas, monospace" font-size="11" font-weight="700" fill="#1e3a5f">Shader Identifier</text>
<text x="36" y="232" font-family="Consolas, monospace" font-size="10.5" fill="#4b5563">32B · 드라이버 발급 토큰</text>
<rect x="208" y="192" width="88" height="52" fill="#fdf1dc" stroke="#d9a441" stroke-width="1.5"/>
<text x="216" y="212" font-family="Consolas, monospace" font-size="10" fill="#5c4308">RootConstants</text>
<text x="216" y="226" font-family="Consolas, monospace" font-size="9.5" fill="#8a6716">Config·IB오프셋</text>
<text x="216" y="239" font-family="Consolas, monospace" font-size="9.5" fill="#8a6716">FirstPrim·UserData</text>
<rect x="296" y="192" width="86" height="52" fill="#fbe6cf" stroke="#d9a441" stroke-width="1.5"/>
<text x="304" y="214" font-family="Consolas, monospace" font-size="10" fill="#5c4308">IB 인덱스/VA</text>
<text x="304" y="230" font-family="Consolas, monospace" font-size="9.5" fill="#8a6716">union 4B/8B</text>
<rect x="382" y="192" width="86" height="52" fill="#fbe6cf" stroke="#d9a441" stroke-width="1.5"/>
<text x="390" y="214" font-family="Consolas, monospace" font-size="10" fill="#5c4308">VB 인덱스/VA</text>
<text x="390" y="230" font-family="Consolas, monospace" font-size="9.5" fill="#8a6716">union 4B/8B</text>
<rect x="468" y="192" width="268" height="52" rx="4" fill="#fdeef0" stroke="#d6304a" stroke-width="1.5"/>
<text x="480" y="214" font-family="Consolas, monospace" font-size="11" font-weight="700" fill="#a3243a">루트 CBV GPU VA × N</text>
<text x="480" y="232" font-family="Consolas, monospace" font-size="10.5" fill="#4b5563">유니폼 버퍼 주소 8B씩 · (비-bindless면 +테이블 핸들)</text>
<path d="M 208 252 L 208 262 L 468 262 L 468 252" fill="none" stroke="#8a6716" stroke-width="1.2"/>
<text x="272" y="280" font-family="Segoe UI, sans-serif" font-size="11" fill="#8a6716">시스템 파라미터 32B: 항상 로컬 루트 시그니처의 첫 파라미터</text>
<text x="24" y="316" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#6b7484">레코드 인덱스 = 할당 베이스 + 레이어 오프셋 + 세그먼트 × 2 + 슬롯(0 = 머티리얼, 1 = 섀도). 이 값이 TLAS 인스턴스의</text>
<text x="24" y="332" font-family="Consolas, monospace" font-size="11" fill="#6b7484">InstanceContributionToHitGroupIndex로도 들어가 GPU의 레코드 주소 산식과 만난다.</text>
</svg>
<div class="scene-cap">SBT의 물리 구조. 히트그룹·콜러블·미스 레코드가 한 버퍼에 서브테이블로 이어지고(RayGen만 디스패치마다 임시 업로드), 레코드 한 줄은 식별자 32B + 시스템 파라미터 32B + 루트 CBV 주소들이다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
줄 번호 계산도 언리얼의 규칙이 명확하다. 지오메트리 세그먼트 하나당 레코드 <strong>2줄</strong>(슬롯 0 = 머티리얼, 슬롯 1 = 섀도, <code>RAY_TRACING_NUM_SHADER_SLOTS = 2</code>)이고, 렌더러의 <code>FRayTracingSBTAllocation::GetRecordIndex</code>(<code>RayTracingShaderBindingTable.cpp:77</code>)가 "베이스 + 레이어 오프셋 + 세그먼트 × 2 + 슬롯"으로 인덱스를 만든다. 이 값이 TLAS(씬 전체의 인스턴스 가속 구조) 인스턴스의 <code>InstanceContributionToHitGroupIndex</code>에 들어가서, GPU가 히트 시 DXR 사양의 산식 <code>HitGroupTable.Start + Stride × (RayContribution + Multiplier × GeometryContribution + InstanceContribution)</code>으로 정확히 그 줄을 찾아온다.
</p>

<p style="color:var(--text2);line-height:1.85;">
셰이더 쪽에서 읽는 코드까지 보면 흐름이 완성된다. 히트 셰이더 공통 코드 <code>RayTracingHitGroupCommon.ush:97</code>의 <code>LoadTriangleBaseAttributes()</code>가 <code>HitGroupSystemRootConstants</code>의 스트라이드/오프셋으로 <code>HitGroupSystemIndexBuffer</code>/<code>HitGroupSystemVertexBuffer</code>에서 삼각형 정점을 직접 페치한다. 이 두 버퍼 선언이 레코드의 union과 어떻게 이어지는지, 즉 <strong>주소가 레코드에 기록되는 과정</strong>이 다음 장이다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">06 — 바인딩 두 경로</span>
</div>

# 메모리 주소는 어떻게 레코드에 기록되는가: bindless와 비-bindless

<div class="research-post">
<div class="callout callout-info">
<div class="callout-title">언제 불리나: 전체 흐름의 ④→⑤</div>
렌더 스레드의 병렬 태스크(<code>BindRayTracingMaterialPipeline</code>, 최대 5워커)가 이번 프레임 dirty인 레코드의 바인딩 목록을 만들어 RHI 커맨드로 큐잉하고, RHI 스레드가 <code>RHISetBindingsOnShaderBindingTable</code>을 실행하는 순간 이 장의 함수들이 레코드 메모리에 실제로 쓴다. 매 프레임 모든 레코드가 아니라 dirty 레코드만 지나간다(07장).
</div>

<p style="color:var(--text2);line-height:1.85;">
본론에 들어가기 전에 bindless라는 말부터 정리하자. 셰이더가 텍스처나 버퍼를 읽으려면 "이 셰이더의 t0 슬롯은 이 텍스처다"라고 연결해 주는 작업이 필요하고, 이것이 바인딩이다. <strong>비-bindless(전통) 방식</strong>은 드로우콜이나 디스패치마다 셰이더의 고정 슬롯(t0, t1, …)에 리소스의 디스크립터를 하나하나 복사해 묶어 준다. 식당으로 치면 손님(셰이더)이 올 때마다 그 좌석에 수저를 미리 세팅해 주는 방식이다. 슬롯의 개수와 종류가 셰이더 컴파일 시점에 고정되고, CPU가 매번 세팅 비용을 낸다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>bindless 방식</strong>은 반대다. 모든 리소스의 디스크립터를 전역 디스크립터 힙 하나에 등록해 두고, 셰이더에는 "몇 번째 칸"이라는 정수 인덱스만 준다. 셰이더는 <code>ResourceDescriptorHeap[인덱스]</code>로 아무 리소스나 직접 꺼내 쓴다. 공용 선반에 도구를 전부 올려 두고 선반 번호만 쪽지로 건네는 방식이다. 바인딩이 "디스크립터 복사"에서 "정수 하나 전달"로 줄어드니, 어떤 셰이더가 무엇을 읽게 될지 미리 다 묶어 두기 어려운 레이트레이싱과 잘 맞는다. 언리얼 5.8의 레이트레이싱은 bindless가 기본 경로이고 비-bindless 폴백도 남아 있어서, 이 장은 두 경로를 모두 따라간다.
</p>

<div class="callout callout-purple">
<div class="callout-title">루트 시그니처가 뭔가: 셰이더의 함수 시그니처</div>
용어 하나 더 정리하자. C++에서 함수 시그니처가 "이 함수는 인자를 이 타입, 이 순서로 받는다"라는 약속이듯, <strong>루트 시그니처(root signature)</strong>는 "이 셰이더는 리소스를 이 종류, 이 순서로 받는다"를 정해 둔 명세다. 상수 몇 개, 버퍼 주소 몇 개, 디스크립터 테이블 몇 개가 어떤 순서로 오는지를 파이프라인 생성 때 미리 등록해 두면, 값을 넣는 앱 쪽과 값을 읽는 셰이더 쪽이 그 약속대로 움직인다. 이름의 signature가 바로 이 "약속된 인자 형태"라는 뜻이다. 레이트레이싱에는 이것이 두 층 있다. <strong>글로벌 루트 시그니처</strong>는 디스패치 전체가 공유하는 파라미터로 커맨드리스트에 직접 바인딩되고, <strong>로컬 루트 시그니처</strong>는 SBT 레코드 한 줄에서 읽는 레코드별 파라미터다. 그리고 로컬 루트 시그니처의 파라미터 순서가 곧 레코드의 바이트 배치가 된다. 이 장에서 계속 확인할 사실이 이것이다.
</div>

<p style="color:var(--text2);line-height:1.85;">
레코드에 값을 채우는 함수는 <code>SetRayTracingShaderResources</code>(<code>D3D12RayTracing.cpp:5572</code>) 하나인데, 템플릿 인자로 주입되는 <strong>바인더</strong>에 따라 동작이 둘로 갈린다. <code>FD3D12RayTracingGlobalResourceBinder</code>는 raygen 셰이더의 글로벌 바인딩용으로, <code>SetComputeRoot*</code>를 커맨드리스트에 직접 친다. <code>FD3D12RayTracingLocalResourceBinder</code>는 히트그룹/미스/콜러블용으로, <strong>같은 호출이 SBT 레코드 메모리에 기록</strong>된다. 기록 오프셋은 루트 시그니처<span class="fn-note"><input type="checkbox" id="fn-rootsig" class="fn-toggle"><label for="fn-rootsig" class="fn-ref">5</label><span class="fn-body"><strong>루트 시그니처(root signature):</strong> 셰이더가 받을 파라미터의 목록과 순서를 미리 못박아 둔 선언이다. C 함수의 시그니처가 인자의 개수와 타입을 정하듯, 루트 시그니처는 "0번 자리에 상수 버퍼 주소, 1번 자리에 디스크립터 테이블…" 식으로 자리 배치를 정한다. 그래서 <strong>루트 시그니처의 바이트 레이아웃이 곧 SBT 레코드의 레이아웃</strong>이 된다. 레이 트레이싱에서는 두 종류로 나뉘는데, 글로벌 루트 시그니처는 디스패치 전체가 공유하고, 로컬 루트 시그니처는 레코드마다 따로 붙어서 히트그룹별로 다른 리소스를 받게 해 준다.</span></span>가 정한다. 루트 시그니처의 바이트 레이아웃이 곧 레코드 레이아웃이다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12RayTracing.cpp:5473 (로컬 바인더: 레코드에 8바이트 기록)</div><span class="kw">void</span> <span class="ty">SetRootDescriptor</span>(<span class="kw">uint32</span> BaseSlotIndex, <span class="kw">uint32</span> DescriptorIndex, <span class="ty">D3D12_GPU_VIRTUAL_ADDRESS</span> Address)
{
    <span class="cm">// 루트 시그니처 슬롯의 바이트 오프셋 + 8B × 인덱스 = 레코드 안의 위치</span>
    <span class="kw">const uint32</span> OffsetWithinRootSignature = ComputeOffsetWithinRootSignature(BaseSlotIndex, DescriptorIndex);
    ShaderTable.SetLocalShaderParameters(ShaderTableOffset, RecordIndex, OffsetWithinRootSignature, Address);
}</div>

<div class="scene-fig">
<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="로컬 루트 시그니처의 파라미터 슬롯 목록이 SBT 레코드 안의 바이트 위치로 그대로 변환되는 그림. SetRootCBV로 슬롯 번호를 주면 루트 시그니처가 오프셋을 알려주고 레코드의 그 자리에 8바이트를 쓴다">
<defs><marker id="rs-a" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#6b7484"/></marker></defs>
<text x="24" y="30" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2b2f3d">로컬 루트 시그니처 (파라미터 목록)</text>
<rect x="24" y="40" width="300" height="180" rx="8" fill="#f3f6fb" stroke="#2b2f3d" stroke-width="1.5"/>
<rect x="40" y="54" width="268" height="34" rx="4" fill="#fdf1dc" stroke="#d9a441"/>
<text x="50" y="68" font-family="Consolas, monospace" font-size="10" fill="#5c4308">파라미터 0: 시스템 상수 32B</text>
<text x="50" y="82" font-family="Consolas, monospace" font-size="9.5" fill="#8a6716">오프셋 0</text>
<rect x="40" y="94" width="268" height="34" rx="4" fill="#fdeef0" stroke="#d6304a"/>
<text x="50" y="108" font-family="Consolas, monospace" font-size="10" fill="#a3243a">파라미터 1: 루트 CBV (b1)</text>
<text x="50" y="122" font-family="Consolas, monospace" font-size="9.5" fill="#8a6716">오프셋 32</text>
<rect x="40" y="134" width="268" height="34" rx="4" fill="#fdeef0" stroke="#d6304a"/>
<text x="50" y="148" font-family="Consolas, monospace" font-size="10" fill="#a3243a">파라미터 2: 루트 CBV (b2)</text>
<text x="50" y="162" font-family="Consolas, monospace" font-size="9.5" fill="#8a6716">오프셋 40</text>
<rect x="40" y="174" width="268" height="34" rx="4" fill="#e6e9f0" stroke="#9aa4b2"/>
<text x="50" y="188" font-family="Consolas, monospace" font-size="10" fill="#3d4654">파라미터 3: 디스크립터 테이블 (비-bindless)</text>
<text x="50" y="202" font-family="Consolas, monospace" font-size="9.5" fill="#8a6716">오프셋 48</text>
<text x="436" y="30" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2b2f3d">SBT 레코드 (바이트 위치 = 32 + 오프셋)</text>
<rect x="436" y="40" width="300" height="180" rx="8" fill="#ffffff" stroke="#3b82c4" stroke-width="1.5"/>
<rect x="452" y="54" width="268" height="26" rx="4" fill="#dfe9f7"/><text x="462" y="71" font-family="Consolas, monospace" font-size="10" fill="#1e3a5f">0~31: 셰이더 식별자</text>
<rect x="452" y="86" width="268" height="26" rx="4" fill="#fdf1dc"/><text x="462" y="103" font-family="Consolas, monospace" font-size="10" fill="#5c4308">32~63: 시스템 파라미터</text>
<rect x="452" y="118" width="268" height="26" rx="4" fill="#fdeef0"/><text x="462" y="135" font-family="Consolas, monospace" font-size="10" fill="#a3243a">64~71: b1의 GPU 주소 (8B)</text>
<rect x="452" y="150" width="268" height="26" rx="4" fill="#fdeef0"/><text x="462" y="167" font-family="Consolas, monospace" font-size="10" fill="#a3243a">72~79: b2의 GPU 주소 (8B)</text>
<rect x="452" y="182" width="268" height="26" rx="4" fill="#e6e9f0"/><text x="462" y="199" font-family="Consolas, monospace" font-size="10" fill="#3d4654">80~87: 테이블 GPU 핸들 (8B)</text>
<path d="M 308 71 L 450 99" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#rs-a)"/>
<path d="M 308 111 L 450 131" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#rs-a)"/>
<path d="M 308 151 L 450 163" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#rs-a)"/>
<path d="M 308 191 L 450 195" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#rs-a)"/>
<text x="24" y="252" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#4b5563">SetRootCBV(슬롯 1, 주소)를 부르면: 루트 시그니처가 "슬롯 1 = 오프셋 32"라고 알려주고 → 레코드의 32 + 32 = 64번째 바이트에 주소 8B를 쓴다.</text>
<text x="24" y="270" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#6b7484">글로벌 바인더는 같은 호출을 커맨드리스트의 SetComputeRootCBV로 보낸다. 목적지만 다르고 슬롯 계산은 같다.</text>
</svg>
<div class="scene-cap">루트 시그니처가 곧 레코드의 배치도다. 바인딩 함수는 슬롯 번호로 말하고, 루트 시그니처가 그것을 바이트 오프셋으로 변환하며, 이 변환표가 있어서 bindless/비-bindless 분기도 결국 "어느 칸에 무엇을 쓰느냐"의 차이가 된다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
유니폼 버퍼(UB, 머티리얼 파라미터 같은 셰이더 상수 묶음을 담는 버퍼)는 두 모드 공통으로 이 경로를 탄다. UB의 GPU 가상 주소가 루트 CBV로 레코드에 8바이트씩 기록된다. 갈라지는 것은 SRV/UAV/샘플러(순서대로 셰이더가 읽는 리소스 뷰, 셰이더가 쓰는 뷰, 텍스처 필터링 설정)다. <strong>비-bindless</strong> 모드에서는 셰이더가 쓰는 디스크립터들을 SBT 전용 <code>FD3D12ExplicitDescriptorCache</code>에 복사해 테이블을 만들고, 그 테이블의 GPU 핸들 8바이트를 레코드에 쓴다. <strong>bindless</strong> 모드에서는 여기서 흔한 오해가 하나 깨진다. 바인딩이 "인덱스 전달"로 줄었으니 레코드에 인덱스들이 줄줄이 기록될 것 같지만, 실제 코드는 다르다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12RayTracing.cpp:5647 (bindless에서 SetSRV가 하는 일)</div><span class="kw">void</span> <span class="ty">SetSRV</span>(<span class="ty">FRHIShaderResourceView</span>* RHISRV, <span class="kw">uint8</span> Index)
{
    ...
    <span class="kw">if</span> (!bBindlessResources)   <span class="cm">// bindless면 디스크립터 복사를 통째로 건너뛴다</span>
    {
        LocalSRVs[Index] = SRV-&gt;GetOfflineCpuHandle();   <span class="cm">// 비-bindless만 테이블에 수집</span>
        ...
    }
    Binder.AddReferencedShaderResource(SRV-&gt;GetShaderResource());  <span class="cm">// 참조 등록은 모드 무관 (07장)</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
bindless에서 SRV의 디스크립터 힙 인덱스는 이미 <strong>유니폼 버퍼의 내용물</strong>(또는 loose 파라미터<span class="fn-note"><input type="checkbox" id="fn-loose" class="fn-toggle"><label for="fn-loose" class="fn-ref">6</label><span class="fn-body"><strong>loose 파라미터:</strong> 유니폼 버퍼로 묶이지 않고 셰이더에 낱개로 넘어가는 상수 값들을 가리키는 언리얼 용어다. 버퍼를 따로 만들 만큼 크지 않은 자잘한 값들이라, RHI가 모아서 임시 상수 버퍼에 담아 넘긴다(<code>SetLooseParameterData</code>). 레코드 입장에서는 결국 유니폼 버퍼와 똑같이 "주소 하나"로 기록된다.</span></span> 상수 데이터)로 들어가 있고, 레코드에는 그 UB의 주소만 기록된다. 레코드에 인덱스가 직접 기록되는 유일한 예외가 05장의 시스템 IB/VB 두 개다. 이 둘은 UB를 거칠 수 없는 시스템 소유 리소스라 32바이트 루트 상수로 레코드에 통째로 들어간다. 그러면 셰이더의 <code>ByteAddressBuffer HitGroupSystemIndexBuffer;</code>라는, register 지정도 없는 선언은 어떻게 그 인덱스와 연결되는가. HLSL 매크로도 DXIL 바이너리 패치도 아니고, <strong>DXC(셰이더 컴파일러)에 소스가 들어가기 직전에 문자열 재작성기(rewriter)가 선언을 통째로 고쳐 쓴다</strong>. <code>FShaderParameterParser::ParseAndModify</code>가 register 지정 없는 전역 SRV 선언을 찾아내고, D3D 백엔드의 <code>GenerateBindlessAccess</code>(<code>D3DShaderCompiler.cpp:1404</code>)가 이 두 이름만 특수 취급해 인덱스 식을 레코드의 루트 상수 필드로 바꿔치기한다. 최종적으로 DXC가 받는 코드는 이렇다.
</p>

<div class="code-block"><div class="code-lang">HLSL — rewriter 통과 후 (DXC에 실제로 들어가는 형태)</div><span class="cm">// ByteAddressBuffer HitGroupSystemIndexBuffer;  ← 원래 선언이 아래로 재작성된다</span>
<span class="kw">typedef</span> <span class="ty">ByteAddressBuffer</span> SafeTypeHitGroupSystemIndexBuffer;
SafeTypeHitGroupSystemIndexBuffer <span class="ty">GetBindlessSRVHitGroupSystemIndexBuffer</span>()
{
    <span class="kw">return</span> ResourceDescriptorHeap[NonUniformResourceIndex(
        D3DHitGroupSystemParameters.BindlessHitGroupSystemIndexBuffer)];  <span class="cm">// ← 레코드의 루트 상수</span>
}
<span class="kw">static const</span> SafeTypeHitGroupSystemIndexBuffer HitGroupSystemIndexBuffer
    = GetBindlessSRVHitGroupSystemIndexBuffer();</div>

<div class="scene-fig">
<svg viewBox="0 0 760 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="비-bindless와 bindless 두 바인딩 경로 비교. 비-bindless는 레코드에 주소와 테이블 핸들이 기록되고, bindless는 레코드에 시스템 인덱스와 UB 주소만 기록되며 나머지 인덱스는 UB 내용물로 전달된다">
<defs><marker id="bp-a" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#6b7484"/></marker></defs>
<text x="24" y="28" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2b2f3d">비-bindless 경로</text>
<rect x="24" y="40" width="340" height="120" rx="8" fill="#f3f6fb" stroke="#c9d2e0"/>
<rect x="40" y="56" width="180" height="26" rx="4" fill="#fbe6cf" stroke="#d9a441"/><text x="48" y="73" font-family="Consolas, monospace" font-size="10" fill="#5c4308">레코드: IB/VB GPU VA (8B×2)</text>
<rect x="40" y="90" width="180" height="26" rx="4" fill="#fdeef0" stroke="#d6304a"/><text x="48" y="107" font-family="Consolas, monospace" font-size="10" fill="#a3243a">레코드: 테이블 GPU 핸들 (8B)</text>
<rect x="40" y="124" width="180" height="26" rx="4" fill="#fdeef0" stroke="#d6304a"/><text x="48" y="141" font-family="Consolas, monospace" font-size="10" fill="#a3243a">레코드: 루트 CBV VA × N</text>
<rect x="248" y="90" width="100" height="26" rx="4" fill="#e6e9f0" stroke="#9aa4b2"/><text x="256" y="107" font-family="Consolas, monospace" font-size="9.5" fill="#3d4654">디스크립터 테이블</text>
<path d="M 220 103 L 246 103" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#bp-a)"/>
<text x="24" y="196" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2b2f3d">bindless 경로</text>
<rect x="24" y="208" width="340" height="106" rx="8" fill="#f3f6fb" stroke="#c9d2e0"/>
<rect x="40" y="224" width="200" height="26" rx="4" fill="#fbe6cf" stroke="#d9a441"/><text x="48" y="241" font-family="Consolas, monospace" font-size="10" fill="#5c4308">레코드: 시스템 IB/VB 인덱스 (4B×2)</text>
<rect x="40" y="258" width="200" height="26" rx="4" fill="#fdeef0" stroke="#d6304a"/><text x="48" y="275" font-family="Consolas, monospace" font-size="10" fill="#a3243a">레코드: 루트 CBV VA × N</text>
<rect x="258" y="258" width="92" height="26" rx="4" fill="#e9f6f4" stroke="#2a9d8f"/><text x="266" y="275" font-family="Consolas, monospace" font-size="9.5" fill="#1e6e64">UB 내용물에</text>
<text x="266" y="296" font-family="Consolas, monospace" font-size="9.5" fill="#1e6e64">SRV 인덱스들</text>
<path d="M 240 271 L 256 271" fill="none" stroke="#6b7484" stroke-width="1.4" marker-end="url(#bp-a)"/>
<rect x="420" y="40" width="316" height="274" rx="8" fill="#ffffff" stroke="#c9d2e0"/>
<text x="436" y="66" font-family="Segoe UI, sans-serif" font-size="12.5" font-weight="700" fill="#2b2f3d">GPU에서의 읽기</text>
<text x="436" y="94" font-family="Consolas, monospace" font-size="10.5" fill="#4b5563">비-bindless:</text>
<text x="436" y="112" font-family="Consolas, monospace" font-size="10.5" fill="#6b7484">VA → 버퍼 직접 · 핸들 → 테이블 → 리소스</text>
<text x="436" y="146" font-family="Consolas, monospace" font-size="10.5" fill="#4b5563">bindless:</text>
<text x="436" y="164" font-family="Consolas, monospace" font-size="10.5" fill="#6b7484">ResourceDescriptorHeap[레코드의 인덱스]</text>
<text x="436" y="182" font-family="Consolas, monospace" font-size="10.5" fill="#6b7484">ResourceDescriptorHeap[UB 안의 인덱스]</text>
<rect x="436" y="204" width="284" height="94" rx="6" fill="#fdf7ec" stroke="#d9a441"/>
<text x="450" y="228" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#8a6716">공통점이 핵심이다</text>
<text x="450" y="250" font-family="Segoe UI, sans-serif" font-size="11" fill="#4b5563">어느 쪽이든 레코드에 남는 것은 raw 주소나</text>
<text x="450" y="268" font-family="Segoe UI, sans-serif" font-size="11" fill="#4b5563">인덱스뿐. 리소스가 살아 있고 VRAM에 있다는</text>
<text x="450" y="286" font-family="Segoe UI, sans-serif" font-size="11" fill="#4b5563">보장은 레코드 밖에서 따로 만들어야 한다</text>
</svg>
<div class="scene-cap">두 바인딩 경로. bindless라고 레코드에 인덱스가 줄줄이 기록되는 게 아니다. 레코드에 직접 기록되는 인덱스는 시스템 IB/VB뿐이고, 나머지는 UB 내용물로 흘러간다. 어느 쪽이든 레코드가 담는 것은 보장 없는 참조다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
정리하면 레코드에 남는 것은 GPU 가상 주소(UB, 비-bindless IB/VB), 디스크립터 테이블 핸들(비-bindless SRV들), 디스크립터 힙 인덱스(bindless 시스템 IB/VB)의 세 종류이고, 셋 다 <strong>그 리소스가 계속 존재하고 VRAM에 있다는 보장이 전혀 없는 raw 참조</strong>다. 그래서 위 <code>SetSRV</code> 코드의 마지막 줄, 모드와 무관하게 항상 실행되는 <code>AddReferencedShaderResource</code>가 있다. 주소를 쓰는 순간 그 리소스를 딴 곳에 기억해 두는 것, 선언 흐름이 여기서 시작된다.
</p>

<p style="color:var(--text2);line-height:1.85;">
여기서 오해 하나를 미리 깨 두자. 세 종류 중 루트 CBV가 가리키는 유니폼 버퍼는 CPU가 매 프레임 값을 쓰는 업로드 힙, 즉 <strong>시스템 RAM</strong>에 있다. "시스템 RAM에 있으니 VRAM 압박과는 무관하겠지"라는 직관이 자연스럽지만 틀렸다. <code>Evict</code>는 "VRAM에서 내린다"가 아니라 <strong>GPU 페이지 테이블에서 그 주소의 매핑을 지우는</strong> API라서(01장), 물리 메모리가 어느 쪽에 있든 evict된 주소를 GPU가 읽으면 똑같이 주소 변환 실패다. 그리고 04장의 표에서 봤듯 업로드 힙 SmallBlock(4MiB)도 VRAM 풀과 똑같이 ManagedObject로 추적되는 블록이다. 유니폼 버퍼 수백 개가 4MiB 블록 하나를 나눠 쓰므로, 블록이 evict되는 순간 그 안의 UB 전부가 한꺼번에 GPU에서 접근 불가가 된다. 레코드에 기록된 루트 CBV 주소도 VB/IB와 정확히 같은 계약을 따른다. 등록이 있어야 접근이 보장된다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 대목을 <strong>실전 코드 루트</strong>를 따라 처음부터 끝까지 이어서 확인해 보자. <code>SetRayTracingShaderResources</code>의 초입에는 렌더러가 넘긴 바인딩 배열을 타입별로 분배하는 switch가 있다. 히트그룹 하나가 바인딩될 때 리소스들이 이 다섯 케이스 중 하나로 들어온다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12RayTracing.cpp:5753 (바인딩 타입 분배 switch)</div><span class="kw">for</span> (<span class="kw">uint32</span> BindlessParameterIndex = <span class="num">0</span>; BindlessParameterIndex &lt; InNumBindlessParameters; ++BindlessParameterIndex)
{
    <span class="kw">const</span> <span class="ty">FRHIShaderParameterResource</span>&amp; ShaderParameterResource = BindlessParameters[BindlessParameterIndex];
    <span class="kw">if</span> (<span class="ty">FRHIResource</span>* Resource = ShaderParameterResource.Resource)
    {
        <span class="kw">switch</span> (ShaderParameterResource.Type)
        {
            <span class="kw">case</span> <span class="ty">FRHIShaderParameterResource::EType</span>::Texture:
                Bindings.SetTexture(<span class="kw">static_cast</span>&lt;<span class="ty">FRHITexture</span>*&gt;(Resource), BindlessParameterIndex);
                <span class="kw">break</span>;
            <span class="kw">case</span> <span class="ty">FRHIShaderParameterResource::EType</span>::ResourceView:
                Bindings.SetSRV(<span class="kw">static_cast</span>&lt;<span class="ty">FRHIShaderResourceView</span>*&gt;(Resource), BindlessParameterIndex);
                <span class="kw">break</span>;
            <span class="kw">case</span> <span class="ty">FRHIShaderParameterResource::EType</span>::UnorderedAccessView:
                Bindings.SetUAV(<span class="kw">static_cast</span>&lt;<span class="ty">FRHIUnorderedAccessView</span>*&gt;(Resource), BindlessParameterIndex);
                <span class="kw">break</span>;
            <span class="kw">case</span> <span class="ty">FRHIShaderParameterResource::EType</span>::Sampler:
                Bindings.SetSampler(<span class="kw">static_cast</span>&lt;<span class="ty">FRHISamplerState</span>*&gt;(Resource), BindlessParameterIndex);
                <span class="kw">break</span>;
            <span class="kw">case</span> <span class="ty">FRHIShaderParameterResource::EType</span>::ResourceCollection:
                Bindings.SetResourceCollection(<span class="kw">static_cast</span>&lt;<span class="ty">FRHIResourceCollection</span>*&gt;(Resource), BindlessParameterIndex);
                <span class="kw">break</span>;
        }
    }
}</div>

<p style="color:var(--text2);line-height:1.85;">
다섯 케이스 중 <code>ResourceCollection</code>이 선언 흐름의 성격을 가장 잘 보여준다. 리소스 컬렉션은 bindless 인덱스들을 담은 버퍼 하나로 여러 리소스를 묶어 바인딩하는 장치다. 셰이더는 컬렉션 버퍼를 읽고, 그 안의 인덱스로 다시 멤버 리소스를 읽는다. 그러니 컬렉션 버퍼만 등록해서는 부족하고, <strong>멤버 전부의 residency를 함께 보장</strong>해야 한다. 실제 코드가 정확히 그렇게 한다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12RayTracing.cpp:5693 (SetResourceCollection: 멤버 전부를 등록에 끌어들인다)</div><span class="kw">void</span> <span class="ty">SetResourceCollection</span>(<span class="ty">FRHIResourceCollection</span>* ResourceCollection, <span class="kw">uint8</span> Index)
{
    <span class="ty">FD3D12ResourceCollection</span>* D3D12ResourceCollection = FD3D12CommandContext::RetrieveObject&lt;...&gt;(ResourceCollection, GPUIndex);
    <span class="ty">FD3D12ShaderResourceView</span>* SRV = D3D12ResourceCollection ? D3D12ResourceCollection-&gt;GetShaderResourceView() : <span class="kw">nullptr</span>;
    ...
    Binder.AddReferencedShaderResource(SRV-&gt;GetShaderResource());       <span class="cm">// ① 컬렉션 버퍼 자신</span>

    <span class="cm">// Ensure all member SRVs referenced by the collection buffer are resident.</span>
    <span class="kw">for</span> (<span class="ty">FD3D12ShaderResourceView</span>* MemberSRV : D3D12ResourceCollection-&gt;AllSrvs)
    {
        Binder.AddReferencedShaderResource(MemberSRV-&gt;GetShaderResource());  <span class="cm">// ② 멤버 전부</span>

        <span class="kw">if</span> (<span class="ty">FD3D12RayTracingScene</span>* ReferencedRayTracingScene = MemberSRV-&gt;GetRayTracingScene())
        {
            ReferencedRayTracingScenes.Add(ReferencedRayTracingScene);       <span class="cm">// ③ 중첩된 씬 → 08장의 씬 등록 목록으로</span>
        }
    }

    <span class="cm">// Resolve texture references to their current textures and ensure residency.</span>
    <span class="kw">for</span> (<span class="ty">FD3D12RHITextureReference</span>* TextureReference : D3D12ResourceCollection-&gt;AllTextureReferences)
    {
        <span class="kw">if</span> (TextureReference)
        {
            Binder.AddReferencedTexture(TextureReference);                   <span class="cm">// ④ 텍스처 레퍼런스는 현재 텍스처로 해석</span>
        }
    }
}</div>

<p style="color:var(--text2);line-height:1.85;">
주석 그대로다. 컬렉션 버퍼 자신(①), 멤버 SRV 전부(②), 멤버 중 레이트레이싱 씬이 있으면 씬의 등록 목록(③, 08장), 텍스처 레퍼런스는 지금 가리키는 실제 텍스처(④)까지. 선언 흐름은 GPU가 간접적으로라도 닿을 수 있는 모든 것을 이렇게 집요하게 쫓아가야 성립한다. 이제 이 switch에서 등록된 텍스처 하나가 evict됐다가 되살아나는 왕복 전체를 코드 위치로 따라가면 이렇다.
</p>

<div class="data-table">
<table>
<tr><th>단계</th><th>코드 위치</th><th>일어나는 일</th></tr>
<tr><td>바인딩</td><td>D3D12RayTracing.cpp:5753 → :5693</td><td>switch가 <code>Bindings.Set*</code>로 분배, <code>AddReferencedShaderResource</code>가 참조를 기억</td></tr>
<tr><td>수집</td><td>:2370 (transient/persistent 분기)</td><td>워커별 <code>DynamicReferencedResources</code> 또는 refcount 맵 + 리스너</td></tr>
<tr><td>마감</td><td>Commit :1683</td><td><code>ReferencedResources</code> 평면 배열로 재구축 + SBT 버퍼 업로드 (07장)</td></tr>
<tr><td>등록</td><td>DispatchRays :6134 → UpdateResidency :2667</td><td>배열 순회하며 <code>CommandContext.UpdateResidency</code> (커맨드리스트당 1회)</td></tr>
<tr><td>삽입</td><td>D3D12CommandList.cpp:11 → :41</td><td><code>GetResidencyHandles()</code>로 블록 핸들 획득 → <code>ResidencySet.Insert</code> (09장)</td></tr>
<tr><td>Submit</td><td>WindowsD3D12Device.cpp:2451</td><td>언리얼 대신 <code>ResidencyManager::ExecuteCommandLists</code>가 큐를 부름</td></tr>
<tr><td>복구</td><td>d3dx12residency.h:1290 (ProcessPagingWork)</td><td>핸들이 EVICTED면 MakeResident 배치에 추가, 타임스탬프 갱신 (10장)</td></tr>
<tr><td>게이트·실행</td><td>:1158 (AsyncThreadFence.GPUWait)</td><td>GPU가 페이징 펜스를 기다린 뒤 실행 → 셰이더가 안전하게 읽음</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
핵심은 <strong>evict와 복구가 렌더러 코드 어디에도 없다</strong>는 점이다. 바인딩 코드는 참조를 기억할 뿐이고, evict는 10장의 매니저가 예산을 보고 알아서 하며, 복구는 등록이 살아 있는 다음 Submit의 <code>ProcessPagingWork</code>가 EVICTED 상태를 발견하는 순간 자동으로 일어난다. 프레임 단위로 그리면 이렇다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="프레임 타임라인. 등록이 유지되는 리소스는 evict됐다가도 다음 Submit에서 MakeResident로 복구되어 GPU가 안전하게 읽지만, 등록이 누락된 리소스는 복구 기회 없이 페이지 폴트가 난다">
<defs><marker id="rt-a" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#6b7484"/></marker></defs>
<g font-family="Consolas, monospace" font-size="11" fill="#4b5563">
<text x="120" y="34">프레임 N</text><text x="300" y="34">프레임 사이</text><text x="500" y="34">프레임 N+1</text>
</g>
<line x1="250" y1="20" x2="250" y2="280" stroke="#d5dbe6" stroke-width="1"/>
<line x1="450" y1="20" x2="450" y2="280" stroke="#d5dbe6" stroke-width="1"/>
<text x="24" y="66" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#1e6e64">등록이 살아 있는 리소스</text>
<rect x="60" y="78" width="150" height="34" rx="6" fill="#e9f6f4" stroke="#2a9d8f" stroke-width="1.5"/>
<text x="72" y="99" font-family="Consolas, monospace" font-size="10.5" fill="#1e6e64">등록 + 사용 · RESIDENT</text>
<rect x="270" y="78" width="150" height="34" rx="6" fill="#eef2f8" stroke="#9aa4b2" stroke-width="1.5" stroke-dasharray="5 3"/>
<text x="282" y="93" font-family="Consolas, monospace" font-size="10" fill="#3d4654">예산 압박 → 블록 evict</text>
<text x="282" y="106" font-family="Consolas, monospace" font-size="10" fill="#8b93a3">(다른 앱이 VRAM 점유)</text>
<rect x="470" y="78" width="266" height="34" rx="6" fill="#e9f6f4" stroke="#2a9d8f" stroke-width="1.5"/>
<text x="482" y="93" font-family="Consolas, monospace" font-size="10" fill="#1e6e64">재등록 → ProcessPagingWork가 EVICTED 발견</text>
<text x="482" y="106" font-family="Consolas, monospace" font-size="10" fill="#1e6e64">→ MakeResident → GPU 게이트 → 읽기 성공</text>
<path d="M 210 95 L 268 95" fill="none" stroke="#6b7484" stroke-width="1.5" marker-end="url(#rt-a)"/>
<path d="M 420 95 L 468 95" fill="none" stroke="#6b7484" stroke-width="1.5" marker-end="url(#rt-a)"/>
<text x="470" y="132" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#4b8a82">앱은 아무것도 몰라도 된다 (페이징 히치만 남는다)</text>
<text x="24" y="176" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#a3243a">등록이 누락된 리소스 (레코드에 주소만 남음)</text>
<rect x="60" y="188" width="150" height="34" rx="6" fill="#e9f6f4" stroke="#2a9d8f" stroke-width="1.5"/>
<text x="72" y="209" font-family="Consolas, monospace" font-size="10.5" fill="#1e6e64">등록 + 사용 · RESIDENT</text>
<rect x="270" y="188" width="150" height="34" rx="6" fill="#eef2f8" stroke="#9aa4b2" stroke-width="1.5" stroke-dasharray="5 3"/>
<text x="282" y="203" font-family="Consolas, monospace" font-size="10" fill="#3d4654">등록 끊김 + 70% 초과</text>
<text x="282" y="216" font-family="Consolas, monospace" font-size="10" fill="#8b93a3">→ 유예 지나 evict</text>
<rect x="470" y="188" width="266" height="34" rx="6" fill="#fdeef0" stroke="#d6304a" stroke-width="1.8"/>
<text x="482" y="203" font-family="Consolas, monospace" font-size="10" fill="#a3243a">재등록 없음 → 복구 기회 없음 → GPU가</text>
<text x="482" y="216" font-family="Consolas, monospace" font-size="10" font-weight="700" fill="#d6304a">레코드의 낡은 주소를 읽음 → PAGE FAULT</text>
<path d="M 210 205 L 268 205" fill="none" stroke="#6b7484" stroke-width="1.5" marker-end="url(#rt-a)"/>
<path d="M 420 205 L 468 205" fill="none" stroke="#6b7484" stroke-width="1.5" marker-end="url(#rt-a)"/>
<text x="470" y="242" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#a3243a">VRAM 넉넉한 개발 머신에서는 evict 자체가 없어 증상이 숨는다</text>
<text x="24" y="278" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#6b7484">두 줄의 차이는 단 하나, 프레임 N+1의 Submit에 그 블록의 핸들이 ResidencySet에 들어 있었는가다.</text>
</svg>
<div class="scene-cap">evict와 복구의 왕복. 등록이 유지되는 한 evict는 투명하게 복구된다. 등록이 끊긴 리소스만 복구 기회 없이 페이지 폴트로 간다. 10장의 ResidencyDebugBudgetMB가 하는 일이 바로 왼쪽 상황을 개발 머신에서 강제하는 것이다.</div>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">07 — 참조 수집과 Commit</span>
</div>

# Commit: 참조 목록 재구축과 GPU 업로드

<div class="research-post">
<div class="callout callout-info">
<div class="callout-title">언제 불리나: 전체 흐름의 ⑤ 끝</div>
렌더러가 바인딩을 밀어 넣은 직후 같은 프레임에 <code>RHICmdList.CommitShaderBindingTable</code>(<code>DeferredShadingRenderer.cpp:1284</code>)을 호출하고, RHI 스레드에서 dirty일 때만 Commit이 실행된다. 참조 수집은 그보다 앞서 06장의 바인딩 도중에 일어난다.
</div>

<p style="color:var(--text2);line-height:1.85;">
<code>AddReferencedShaderResource</code>(<code>D3D12RayTracing.cpp:2370</code>)가 기억하는 방식은 바인딩의 수명에 따라 두 갈래다. <strong>Transient 바인딩</strong>(이번 프레임만 유효)의 참조는 워커 스레드별 <code>DynamicReferencedResources</code> 배열에 쌓였다가 매 프레임 소비되고 비워진다. <strong>Persistent 바인딩</strong>(레코드를 프레임마다 다시 쓰지 않고 유지)의 참조는 참조 횟수(refcount) 맵으로 관리되면서, 레코드마다 <strong>리스너 객체</strong>가 붙는다. 리소스가 스트리밍이나 조각 모음(defrag)으로 자리를 옮기면(rename) 주소가 낡기 때문인데, 이때 리스너가 레코드 안의 주소를 그 자리에서 고쳐 쓴다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12RayTracing.cpp:1976 (UB 리스너: 레코드 제자리 갱신)</div><span class="kw">virtual void</span> <span class="ty">UniformBufferUpdated</span>(...) <span class="kw">final override</span>
{
    <span class="cm">// UB가 새 메모리로 rename됨 → 레코드 안의 루트 CBV 주소를 새 VA로 다시 쓴다</span>
    ShaderTable.SetLocalShaderParameters(ShaderTableOffset, RecordIndex, OffsetWithinRootSignature,
        InUpdatedUniformBuffer-&gt;ResourceLocation.GetGPUVirtualAddress());
    ...
}</div>

<p style="color:var(--text2);line-height:1.85;">
06장에서 모은 기록을 GPU로 올리는 마무리 단계가 <code>Commit</code>(<code>D3D12RayTracing.cpp:1683</code>)이다. 최대 5개 워커가 병렬로 채운 참조들을 병합하고, persistent refcount 맵의 키들과 이번 프레임의 transient 참조를 이어 붙여 <strong><code>ReferencedResources</code>라는 평면 배열 하나로 재구축</strong>한다. 이 배열이 09장에서 디스패치 시 등록의 단일 출처가 된다. 그다음 단계는 예상과 다른데, persistent SBT라 해도 GPU 업로드는 증분이 아니다. <strong>매 Commit마다 새 디폴트 힙 버퍼(VRAM에 두는 GPU 전용 메모리)를 만들어 CPU 미러 전체를 카피 큐(그리기와 병렬로 도는 복사 전용 GPU 큐)로 복사</strong>하고 이전 버퍼는 지연 해제한다. persistent가 아끼는 것은 업로드가 아니라 CPU 쪽 바인딩 재생성(디스크립터/루트 파라미터 재작성) 비용이다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Commit 파이프라인. 워커 5개의 참조가 병합되어 ReferencedResources 평면 배열이 되고, CPU 미러 Data 전체가 새 GPU 버퍼로 카피 큐 업로드된다. 아래에는 bIsDirty를 세우는 유일한 경로와 리스너의 한계가 그려져 있다">
<defs><marker id="cm-a" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#6b7484"/></marker><marker id="cm-r" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#d6304a"/></marker></defs>
<g>
<rect x="24" y="30" width="86" height="30" rx="5" fill="#e9f6f4" stroke="#2a9d8f"/><text x="34" y="49" font-family="Consolas, monospace" font-size="10" fill="#1e6e64">워커 0 refs</text>
<rect x="24" y="66" width="86" height="30" rx="5" fill="#e9f6f4" stroke="#2a9d8f"/><text x="34" y="85" font-family="Consolas, monospace" font-size="10" fill="#1e6e64">워커 1 refs</text>
<rect x="24" y="102" width="86" height="30" rx="5" fill="#e9f6f4" stroke="#2a9d8f"/><text x="34" y="121" font-family="Consolas, monospace" font-size="10" fill="#1e6e64">워커 … refs</text>
</g>
<path d="M 110 81 L 148 81" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#cm-a)"/>
<rect x="150" y="46" width="210" height="70" rx="8" fill="#f3f6fb" stroke="#2b2f3d" stroke-width="1.5"/>
<text x="164" y="72" font-family="Consolas, monospace" font-size="11" font-weight="700" fill="#2b2f3d">ReferencedResources[]</text>
<text x="164" y="92" font-family="Consolas, monospace" font-size="10" fill="#6b7484">persistent refcount 키 + transient</text>
<text x="164" y="106" font-family="Consolas, monospace" font-size="10" fill="#6b7484">→ 09장 디스패치 등록의 단일 출처</text>
<rect x="408" y="30" width="150" height="50" rx="8" fill="#fdf7ec" stroke="#d9a441" stroke-width="1.5"/>
<text x="420" y="52" font-family="Consolas, monospace" font-size="10.5" fill="#5c4308">CPU 미러 Data</text>
<text x="420" y="68" font-family="Consolas, monospace" font-size="10" fill="#8a6716">(레코드 전체)</text>
<path d="M 558 55 L 600 55" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#cm-a)"/>
<text x="562" y="46" font-family="Segoe UI, sans-serif" font-size="10" fill="#6b7484">카피 큐</text>
<rect x="602" y="30" width="134" height="50" rx="8" fill="#eaf1fb" stroke="#3b82c4" stroke-width="1.5"/>
<text x="614" y="52" font-family="Consolas, monospace" font-size="10.5" fill="#1e3a5f">새 GPU 버퍼</text>
<text x="614" y="68" font-family="Consolas, monospace" font-size="10" fill="#4b5563">매번 새로 생성</text>
<path d="M 360 81 L 430 81 L 430 82" fill="none" stroke="#6b7484" stroke-width="0" />
<text x="24" y="170" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#2b2f3d">bIsDirty가 서는 유일한 경로 (그리고 리스너의 한계)</text>
<rect x="24" y="184" width="180" height="40" rx="6" fill="#f3f6fb" stroke="#c9d2e0"/><text x="36" y="202" font-family="Consolas, monospace" font-size="10" fill="#4b5563">렌더러 DirtyPersistentRecords</text><text x="36" y="216" font-family="Consolas, monospace" font-size="9.5" fill="#8b93a3">신규 할당·동적 레코드·재생성</text>
<path d="M 204 204 L 232 204" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#cm-a)"/>
<rect x="234" y="184" width="176" height="40" rx="6" fill="#f3f6fb" stroke="#c9d2e0"/><text x="246" y="202" font-family="Consolas, monospace" font-size="10" fill="#4b5563">SetBindingsOnSBT (RHI)</text><text x="246" y="216" font-family="Consolas, monospace" font-size="9.5" fill="#3b82c4">→ bIsDirty = true (:6571)</text>
<path d="M 410 204 L 438 204" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#cm-a)"/>
<rect x="440" y="184" width="140" height="40" rx="6" fill="#f3f6fb" stroke="#c9d2e0"/><text x="452" y="202" font-family="Consolas, monospace" font-size="10" fill="#4b5563">CommitSBT</text><text x="452" y="216" font-family="Consolas, monospace" font-size="9.5" fill="#8b93a3">dirty일 때만 Commit()</text>
<path d="M 580 204 L 608 204" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#cm-a)"/>
<rect x="610" y="184" width="126" height="40" rx="6" fill="#eaf1fb" stroke="#3b82c4"/><text x="622" y="202" font-family="Consolas, monospace" font-size="10" fill="#1e3a5f">GPU 재업로드</text><text x="622" y="216" font-family="Consolas, monospace" font-size="9.5" fill="#4b5563">Data 전체</text>
<rect x="24" y="248" width="286" height="40" rx="6" fill="#fdeef0" stroke="#d6304a"/><text x="36" y="266" font-family="Consolas, monospace" font-size="10" fill="#a3243a">UB rename / 지오메트리 리스너</text><text x="36" y="280" font-family="Consolas, monospace" font-size="9.5" fill="#6b7484">CPU Data만 패치 · dirty를 못 세움</text>
<path d="M 310 268 C 370 268 400 96 408 80" fill="none" stroke="#d6304a" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#cm-r)"/>
<text x="330" y="304" font-family="Segoe UI, sans-serif" font-size="11" fill="#a3243a">리스너 패치는 "다음번 Commit이 일어날 때" 함께 업로드되는 지연 반영 설계다</text>
</svg>
<div class="scene-cap">Commit 파이프라인과 dirty 체인. bIsDirty를 세우는 곳은 RHI의 SetBindingsOnShaderBindingTable 끝 단 한 줄이고, 리스너의 제자리 패치는 CPU 미러에만 반영되어 다음 Commit에 편승한다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
여기서 짚고 넘어가야 할 설계 특성이 하나 있다. 리스너가 레코드를 고쳐 쓰는 것은 <strong>CPU 미러까지만</strong>이고, 그 자리에서 <code>bIsDirty</code>를 세우지 않는다. 소스 전체에서 <code>bIsDirty = true</code>는 <code>RHISetBindingsOnShaderBindingTable</code>의 끝(<code>:6571</code>) 단 한 곳이다. 즉 GPU 재업로드는 렌더러가 dirty 레코드를 다시 밀어 주는 이벤트(신규 static 할당, 동적 레코드는 매 프레임 무조건, SBT 재생성, 강제 dirty cvar)에 의해서만 일어나고, 리스너 패치는 그 다음 Commit에 편승한다. Lumen의 SBT는 매 프레임 miss 셰이더를 다시 설정하는 코드 덕에 항상 커밋되지만, 머티리얼 SBT의 커밋 블록은 "이번 프레임 바인딩이 하나라도 있을 때"로 가드되어 있다(<code>DeferredShadingRenderer.cpp:1266</code>).
</p>

<div class="callout callout-warn">
<div class="callout-title">이론상의 stale 구멍: 완전 정적 장면 + Shipping 빌드</div>
개발 빌드에서는 <code>r.RayTracing.PersistentSBT.ValidatePersistentBindings</code> 기본값 1이 매 프레임 모든 visible 바인딩을 Validation 타입으로 흘려서 사실상 매 프레임 Commit이 일어난다. 그런데 이 검증이 꺼지는 Test/Shipping 빌드에서, dirty 레코드도 콜러블 바인딩도 0인 완전 정적인 프레임에 persistent 레코드가 참조하는 UB가 rename되면(예: 머티리얼 파라미터 변경), 리스너는 CPU 미러만 고치고 그 프레임의 GPU SBT는 <strong>옛 주소를 든 채 디스패치된다</strong>. 다음 Commit까지 stale이 유지된다. 디스패치 직전의 <code>checkf(!bIsDirty)</code>는 "커밋 안 된 pending 바인딩" 검출용이라 이 상태(bIsDirty=false)는 통과한다. 실전에서 이 조합이 동시에 성립하는 빈도는 낮지만, "persistent SBT는 리스너가 있으니 항상 최신"이라는 가정은 코드상 사실이 아니다.
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">08 — 씬 추적</span>
</div>

# 씬 추적: 아무도 바인딩하지 않는 버퍼는 TLAS가 등록한다

<div class="research-post">
<div class="callout callout-info">
<div class="callout-title">언제 불리나: 전체 흐름의 ③과 ⑥</div>
목록 갱신(<code>UpdateResidencyTracking</code>)은 씬 렌더링 초입의 TLAS 빌드 준비(<code>PrepareAccelerationStructureBuild</code>)에서, 목록 소비(<code>UpdateResidency</code>)는 빌드 시(VB/IB 제외)와 매 디스패치(포함)에서 일어난다.
</div>

<p style="color:var(--text2);line-height:1.85;">
선언 흐름에는 SBT의 <code>ReferencedResources</code>만으로 커버되지 않는 큰 구멍이 있다. 레이트레이싱의 <strong>간접 참조</strong>들이다. TLAS는 내부에 BLAS(개별 메시의 삼각형 가속 구조)들의 GPU 주소를 품고, 히트 셰이더는 05장의 시스템 파라미터로 각 지오메트리의 버텍스/인덱스 버퍼를 읽는다. 그런데 이것들은 <strong>어떤 드로우콜의 바인딩에도 등장하지 않는다</strong>. 디스크립터를 만드는 것도 아니고 배리어<span class="fn-note"><input type="checkbox" id="fn-barrier" class="fn-toggle"><label for="fn-barrier" class="fn-ref">7</label><span class="fn-body"><strong>배리어(resource barrier):</strong> "이 리소스를 지금부터 다른 용도로 쓸 테니 상태를 바꿔라"라고 D3D12에 알리는 명령이다. 렌더 타깃으로 쓰던 텍스처를 셰이더에서 읽으려면 그 사이에 배리어가 필요하다. 배리어를 걸려면 대상 리소스를 지목해야 하므로, 배리어를 거는 것만으로도 "이 커맨드리스트가 이 리소스를 쓴다"는 사실이 드러난다. 본문의 요지는 레이 트레이싱 지오메트리 버퍼가 디스크립터도 배리어도 거치지 않아 그런 계기가 아예 없다는 것이다.</span></span>를 거는 것도 아니니, 커맨드리스트 기록 중에 자동으로 등록될 계기가 없다. 누군가 대신 등록해야 하고, 그 누군가가 <code>FD3D12RayTracingScene</code>(TLAS의 D3D12 구현)이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
씬은 GPU별로 두 개의 목록을 캐시한다. TLAS 빌드에도 트레이스에도 resident여야 하는 <strong>BLAS 가속 구조 버퍼들</strong>(<code>ResourcesToMakeResident</code>)과, 디스패치 시에만 필요한 <strong>버텍스/인덱스 버퍼들</strong>(<code>DispatchResourcesToMakeResident</code>)이다. 5.8에서 이 목록의 구축이 증분 방식으로 바뀌었다(커밋 메시지: "지오메트리 목록은 프레임 간 대부분 안정적이므로, TLAS를 다시 빌드할 때 새로 온 것/바뀐 것/빠진 것만 갱신한다"). <code>TrackedGeometries</code> 맵이 지오메트리별 refcount와 <code>ResourceGeneration</code>(버퍼가 rename될 때마다 증가하는 세대 번호)을 들고, 바뀐 지오메트리만 다시 해석한다. 그리고 마지막 평탄화 단계에서 04장의 구조를 그대로 최적화에 쓴다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12RayTracing.cpp:4832 (residency handle 기준 중복 제거)</div><span class="cm">// Rebuild flat arrays from tracked resources + transient referenced buffers,</span>
<span class="cm">// deduplicating by residency handle to minimize UpdateResidency calls.</span>
<span class="ty">Experimental::TSherwoodSet</span>&lt;<span class="ty">FD3D12ResidencyHandle</span>*&gt; UniqueResidencyHandles;
<span class="kw">auto</span> AddUniqueResource = [&amp;](<span class="kw">const</span> <span class="ty">FD3D12Resource</span>* Resource, ...)
{
    <span class="kw">for</span> (<span class="ty">FD3D12ResidencyHandle</span>* ResidencyHandle : Resource-&gt;GetResidencyHandles())
    {
        <span class="kw">bool</span> bIsAlreadyInSet = <span class="kw">false</span>;
        UniqueResidencyHandles.Add(ResidencyHandle, &amp;bIsAlreadyInSet);
        <span class="kw">if</span> (!bIsAlreadyInSet) { bShouldTrackResidency = <span class="kw">true</span>; }  <span class="cm">// 같은 32MiB 블록이면 한 번만</span>
    }
    ...
};</div>

<div class="scene-fig">
<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="TLAS가 BLAS들을 참조하고 각 BLAS가 버텍스, 인덱스 버퍼를 참조하는 간접 참조 체인. 씬이 두 개의 평탄 목록으로 캐시하고 같은 풀 블록의 버퍼는 핸들 기준으로 한 번만 등록한다">
<defs><marker id="sc-a" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#6b7484"/></marker></defs>
<rect x="24" y="36" width="150" height="54" rx="8" fill="#f3ecfa" stroke="#8b5cf6" stroke-width="1.8"/>
<text x="44" y="60" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#443066">TLAS (씬)</text>
<text x="44" y="78" font-family="Consolas, monospace" font-size="10" fill="#6b7484">인스턴스 → BLAS 주소</text>
<g>
<rect x="240" y="20" width="130" height="40" rx="6" fill="#eaf1fb" stroke="#3b82c4"/><text x="252" y="44" font-family="Consolas, monospace" font-size="10.5" fill="#1e3a5f">BLAS 벽 (AS버퍼)</text>
<rect x="240" y="70" width="130" height="40" rx="6" fill="#eaf1fb" stroke="#3b82c4"/><text x="252" y="94" font-family="Consolas, monospace" font-size="10.5" fill="#1e3a5f">BLAS 나무 (AS버퍼)</text>
<rect x="240" y="120" width="130" height="40" rx="6" fill="#eaf1fb" stroke="#3b82c4"/><text x="252" y="144" font-family="Consolas, monospace" font-size="10.5" fill="#1e3a5f">BLAS 캐릭터 …</text>
</g>
<path d="M 174 56 L 238 42" fill="none" stroke="#6b7484" stroke-width="1.5" marker-end="url(#sc-a)"/>
<path d="M 174 66 L 238 88" fill="none" stroke="#6b7484" stroke-width="1.5" marker-end="url(#sc-a)"/>
<path d="M 174 76 L 238 136" fill="none" stroke="#6b7484" stroke-width="1.5" marker-end="url(#sc-a)"/>
<g>
<rect x="436" y="20" width="120" height="30" rx="5" fill="#fdf7ec" stroke="#d9a441"/><text x="446" y="39" font-family="Consolas, monospace" font-size="10" fill="#5c4308">VB/IB 벽</text>
<rect x="436" y="75" width="120" height="30" rx="5" fill="#fdf7ec" stroke="#d9a441"/><text x="446" y="94" font-family="Consolas, monospace" font-size="10" fill="#5c4308">VB/IB 나무</text>
<rect x="436" y="130" width="120" height="30" rx="5" fill="#fdf7ec" stroke="#d9a441"/><text x="446" y="149" font-family="Consolas, monospace" font-size="10" fill="#5c4308">VB/IB 캐릭터</text>
</g>
<path d="M 370 40 L 434 35" fill="none" stroke="#6b7484" stroke-width="1.5" marker-end="url(#sc-a)"/>
<path d="M 370 90 L 434 90" fill="none" stroke="#6b7484" stroke-width="1.5" marker-end="url(#sc-a)"/>
<path d="M 370 140 L 434 145" fill="none" stroke="#6b7484" stroke-width="1.5" marker-end="url(#sc-a)"/>
<text x="580" y="40" font-family="Segoe UI, sans-serif" font-size="11" fill="#a3243a">이 체인의 어느 것도</text>
<text x="580" y="56" font-family="Segoe UI, sans-serif" font-size="11" fill="#a3243a">드로우콜 바인딩에</text>
<text x="580" y="72" font-family="Segoe UI, sans-serif" font-size="11" fill="#a3243a">등장하지 않는다</text>
<rect x="24" y="196" width="712" height="104" rx="8" fill="#e9f6f4" stroke="#2a9d8f" stroke-width="1.5"/>
<text x="40" y="222" font-family="Segoe UI, sans-serif" font-size="12.5" font-weight="700" fill="#1e6e64">씬의 refcount 캐시 (TLAS 빌드 시 증분 갱신 · 5.8 신규)</text>
<text x="40" y="246" font-family="Consolas, monospace" font-size="10.5" fill="#2b2f3d">ResourcesToMakeResident:         [BLAS AS풀 블록#1][블록#2]…            ← 빌드 + 디스패치</text>
<text x="40" y="266" font-family="Consolas, monospace" font-size="10.5" fill="#2b2f3d">DispatchResourcesToMakeResident: [VB/IB 풀 블록#1][블록#3]…             ← 디스패치에만</text>
<text x="40" y="288" font-family="Consolas, monospace" font-size="10.5" fill="#6b7484">같은 32MiB 블록의 버퍼들은 residency handle 기준 dedup으로 한 번만 등록된다 (04장의 구조를 그대로 활용)</text>
</svg>
<div class="scene-cap">간접 참조 체인과 씬이 대신 해 주는 등록. TLAS를 SRV로 바인딩하는 순간에도 디스크립터 캐시가 씬의 UpdateResidency를 불러 주므로, 레이트레이싱 씬을 쓰는 컴퓨트 셰이더에서도 이 목록이 함께 등록된다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 캐시가 성립하려면 BLAS가 자기 버텍스/인덱스 버퍼를 놓아 버리면 안 된다. 실제로 <code>FD3D12RayTracingGeometry</code>는 빌드가 끝나도 Initializer의 <code>FBufferRHIRef</code>(refcount 참조)를 <strong>객체 수명 내내 유지</strong>하고, 버퍼가 rename되면 리스너로 감지해 <code>ResourceGeneration</code>을 올리고 시스템 파라미터를 다시 계산한다(06장의 레코드 갱신으로 이어진다). 씬의 등록 실행부는 단순하다. <code>FD3D12RayTracingScene::UpdateResidency(CommandContext, bIncludeDispatchResources)</code>(<code>:4889</code>)가 목록을 순회하며 커맨드리스트에 넣는데, TLAS <strong>빌드 시에는 VB/IB를 제외</strong>(false)하고 <strong>디스패치 시에는 포함</strong>(true)해서 부른다. 빌드는 BLAS만 읽고, 트레이스는 히트 셰이더가 VB/IB까지 읽기 때문이다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">09 — 디스패치 선언</span>
</div>

# 디스패치: 네 갈래 등록이 ResidencySet으로 모인다

<div class="research-post">
<div class="callout callout-info">
<div class="callout-title">언제 불리나: 전체 흐름의 ⑥</div>
레이트레이싱 섀도·Lumen·리플렉션 같은 패스가 렌더 스레드에서 큐잉한 디스패치 커맨드를 RHI 스레드가 실행하는 순간이다. 한 프레임에 이 지점을 SBT 하나가 수십 번 지날 수 있다.
</div>

<p style="color:var(--text2);line-height:1.85;">
이제 두 흐름이 만나기 직전이다. <code>RHIRayTraceDispatch</code>가 공통 함수 <code>DispatchRays</code>(<code>D3D12RayTracing.cpp:6012</code>)로 들어가면, 실제 <code>DispatchRays</code> API를 부르기 전에 이번 디스패치가 쓸 모든 것을 커맨드리스트의 ResidencySet에 넣는 등록 절차가 먼저 실행된다. 네 갈래다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="DispatchRays에서 글로벌 바인딩, 씬, SBT, RayGen 레코드 네 갈래의 등록이 커맨드리스트의 ResidencySet 하나로 모이는 그림">
<defs><marker id="dp-a" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#2a9d8f"/></marker></defs>
<g>
<rect x="24" y="30" width="300" height="48" rx="7" fill="#f3f6fb" stroke="#c9d2e0"/>
<text x="38" y="50" font-family="Consolas, monospace" font-size="11" font-weight="700" fill="#2b2f3d">① 글로벌 바인딩 (raygen의 UAV/SRV/UB)</text>
<text x="38" y="68" font-family="Consolas, monospace" font-size="10" fill="#6b7484">글로벌 바인더가 리소스마다 즉시 UpdateResidency</text>
</g>
<g>
<rect x="24" y="90" width="300" height="48" rx="7" fill="#f3ecfa" stroke="#8b5cf6"/>
<text x="38" y="110" font-family="Consolas, monospace" font-size="11" font-weight="700" fill="#443066">② 씬 (TLAS + BLAS + VB/IB)</text>
<text x="38" y="128" font-family="Consolas, monospace" font-size="10" fill="#6b7484">AddRayTracingSceneReference → 08장의 목록 전체</text>
</g>
<g>
<rect x="24" y="150" width="300" height="48" rx="7" fill="#eaf1fb" stroke="#3b82c4"/>
<text x="38" y="170" font-family="Consolas, monospace" font-size="11" font-weight="700" fill="#1e3a5f">③ SBT (ReferencedResources + SBT 버퍼)</text>
<text x="38" y="188" font-family="Consolas, monospace" font-size="10" fill="#6b7484">UniqueId로 커맨드리스트당 1회만 순회 (:2667)</text>
</g>
<g>
<rect x="24" y="210" width="300" height="48" rx="7" fill="#fdf7ec" stroke="#d9a441"/>
<text x="38" y="230" font-family="Consolas, monospace" font-size="11" font-weight="700" fill="#5c4308">④ RayGen 임시 레코드 업로드 버퍼</text>
<text x="38" y="248" font-family="Consolas, monospace" font-size="10" fill="#6b7484">디스패치마다 새로 쓴 64B 레코드의 업로드 힙</text>
</g>
<path d="M 324 54 C 400 54 420 120 470 132" fill="none" stroke="#2a9d8f" stroke-width="1.8" marker-end="url(#dp-a)"/>
<path d="M 324 114 C 390 114 410 130 470 140" fill="none" stroke="#2a9d8f" stroke-width="1.8" marker-end="url(#dp-a)"/>
<path d="M 324 174 C 390 174 410 158 470 148" fill="none" stroke="#2a9d8f" stroke-width="1.8" marker-end="url(#dp-a)"/>
<path d="M 324 234 C 400 234 420 168 470 156" fill="none" stroke="#2a9d8f" stroke-width="1.8" marker-end="url(#dp-a)"/>
<rect x="472" y="104" width="264" height="88" rx="9" fill="#e9f6f4" stroke="#2a9d8f" stroke-width="2"/>
<text x="490" y="132" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#1e6e64">커맨드리스트의 ResidencySet</text>
<text x="490" y="154" font-family="Consolas, monospace" font-size="10.5" fill="#2b2f3d">Insert(블록 핸들) × 전부</text>
<text x="490" y="174" font-family="Consolas, monospace" font-size="10.5" fill="#6b7484">중복은 bool 매트릭스가 O(1) 스킵</text>
<text x="472" y="230" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#4b5563">이 등록이 모두 끝난 뒤에야</text>
<text x="472" y="250" font-family="Consolas, monospace" font-size="11.5" fill="#2b2f3d">SetPipelineState1 → DispatchRays()</text>
<text x="24" y="286" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#a3243a">크래시가 나는 지점이 정확히 여기다: 레코드(05~08장)에 주소는 남아 있는데 이 네 갈래 어디에서도 등록되지 않는 리소스.</text>
</svg>
<div class="scene-cap">디스패치 직전의 등록 절차. SBT는 UniqueId로 같은 커맨드리스트에서의 중복 순회를 피하고, 씬은 08장의 캐시를 그대로 흘려 넣는다. 인다이렉트 디스패치면 인자 버퍼 3종도 추가로 등록된다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
그런데 "등록한다"는 게 코드에서는 정확히 무엇일까. 네 갈래 모두 결국 <code>FD3D12CommandContext::UpdateResidency()</code> 한 함수로 수렴한다. ③(SBT)을 예로 들면 이렇다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12RayTracing.cpp:2667 (SBT가 자기 참조 목록을 등록)</div><span class="cm">// FD3D12RayTracingShaderBindingTableInternal의 멤버</span>
<span class="kw">void</span> <span class="ty">UpdateResidency</span>(<span class="ty">FD3D12CommandContext</span>&amp; CommandContext) <span class="kw">const</span>
{
    <span class="kw">bool</span> bWasAlreadyInSet = <span class="kw">false</span>;
    CommandContext.RayTracingShaderTables.<span class="fn">FindOrAdd</span>(UniqueId, bWasAlreadyInSet);
    <span class="kw">if</span> (bWasAlreadyInSet) <span class="kw">return</span>;        <span class="cm">// 같은 커맨드리스트에서 두 번째부터는 스킵</span>

    <span class="kw">for</span> (<span class="ty">FD3D12Resource</span>* Resource : ReferencedResources)
        CommandContext.<span class="fn">UpdateResidency</span>(Resource);   <span class="cm">// ← 등록은 결국 이 호출이다</span>

    CommandContext.<span class="fn">UpdateResidency</span>(Buffer-&gt;<span class="fn">GetResource</span>());  <span class="cm">// SBT 버퍼 자신도</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
그리고 그 호출의 종착지가 커맨드리스트다. 여기서 04장의 "단위는 버퍼가 아니라 블록"이 코드로 드러난다. 등록되는 것은 리소스가 아니라 그 리소스가 얹힌 <strong>블록의 residency 핸들</strong>이다.
</p>

<div class="code-block"><div class="code-lang">C++ — D3D12CommandList.cpp:11 (등록의 종착지)</div><span class="kw">void</span> <span class="ty">FD3D12CommandList</span>::<span class="fn">UpdateResidency</span>(<span class="kw">const</span> <span class="ty">FD3D12Resource</span>* Resource)
{
    <span class="kw">if</span> (Resource-&gt;<span class="fn">NeedsDeferredResidencyUpdate</span>())          <span class="cm">// reserved(타일) 리소스는 매핑이 바뀌므로</span>
        State.DeferredResidencyUpdateSet.<span class="fn">Add</span>(Resource);    <span class="cm">// 닫을 때 몰아서 처리</span>
    <span class="kw">else</span>
        <span class="fn">AddToResidencySet</span>(Resource-&gt;<span class="fn">GetResidencyHandles</span>());  <span class="cm">// 블록 핸들을 set에 삽입</span>
}</div>

<div class="callout callout-warn">
<div class="callout-title">헷갈리기 쉬운 이웃: AddReferencedUniformBuffer()</div>
<p>같은 파일의 <code>AddReferencedUniformBuffer()</code>(<code>D3D12RayTracing.cpp:2437</code>)는 이름이 비슷하지만 <strong>residency 등록와 무관하다</strong>. 이 함수는 <code>Lifetime</code>과 바인딩 타입이 모두 <code>Persistent</code>일 때만 동작하며, 하는 일은 <code>FRecordUpdateUniformBufferListener</code>를 달아 두는 것이다. 나중에 그 유니폼 버퍼의 주소가 바뀌면 이미 기록해 둔 SBT 레코드를 제자리에서 고쳐 쓰기 위한 장치이고(07장의 레코드 갱신), VRAM에 남길지 말지를 정하는 이 장의 등록와는 다른 축이다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
③의 코드에는 중복 순회를 피하는 장치가 하나 더 있다. 같은 SBT로 한 커맨드리스트에서 수십 번 디스패치하는 것(섀도, 리플렉션, GI가 SBT를 공유한다)이 일상이라, SBT마다 부여된 원자 카운터 <code>UniqueId</code>를 커맨드 컨텍스트의 셋에서 확인해 <strong>커맨드리스트당 한 번만</strong> <code>ReferencedResources</code>를 순회한다. 등록 자체도 04장 덕에 리소스 수가 아니라 블록 수에 비례한다. 등록이 끝나면 커맨드리스트에는 "실행할 것"(DispatchRays 커맨드)과 "필요한 것"(ResidencySet)이 나란히 담긴 채 닫혀서 Submit 스레드(RHISubmissionThread)로 넘어간다. 이로써 두 흐름이 커맨드리스트 하나 안에서 만났다. 남은 것은 Submit 시점에 이 선언대로 VRAM 상태를 맞추는 일이다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">10 — Submit과 페이징</span>
</div>

# Submit: 예산을 재고, 쫓아내고, 복구를 기다린다

<div class="research-post">
<div class="callout callout-info">
<div class="callout-title">언제 불리나: 전체 흐름의 ⑦</div>
RHI 스레드가 옮겨 적기(translate)를 마친 커맨드리스트 묶음(페이로드)을 넘기면 Submit 스레드가 프레임당 여러 번 이 경로를 돈다. evict와 restore가 실제로 일어나는 유일한 장소다.
</div>

<p style="color:var(--text2);line-height:1.85;">
언리얼의 모든 GPU Submit은 RHI Submit 스레드(RHISubmissionThread)의 <code>FD3D12Queue::ExecuteCommandLists</code>를 지나는데, residency 관리가 켜져 있으면 <strong>언리얼은 D3D 큐를 직접 부르지 않는다</strong>. 커맨드리스트 배열과 ResidencySet 배열을 나란히 넘기면 라이브러리의 <code>ResidencyManager::ExecuteCommandLists</code>가 페이징을 끼워 넣고 대신 Submit한다(<code>WindowsD3D12Device.cpp:2451</code>). 내부(<code>ExecuteSubset</code>, <code>d3dx12residency.h:1066</code>)의 순서는 이렇다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">1</div><div class="step-name">예산 폴링</div><div class="step-desc">QueryVideoMemoryInfo를 매 Submit마다 호출</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">2</div><div class="step-name">마스터셋 병합</div><div class="step-desc">배치 내 모든 set을 하나로, 필요 총량 집계</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">3</div><div class="step-name">이분 분할</div><div class="step-desc">필요량이 예산 초과면 배치를 반으로 재귀</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step hot"><div class="step-num">4</div><div class="step-name">ProcessPagingWork</div><div class="step-desc">EVICTED 복구 + 타임스탬프 갱신 + 트리밍</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">5</div><div class="step-name">GPU 게이트</div><div class="step-desc">큐가 페이징 펜스를 Wait (CPU는 안 막힘)</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">6</div><div class="step-name">실행·시그널</div><div class="step-desc">ExecuteCommandLists + 싱크포인트 세대++</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
핵심은 4단계 <code>ProcessPagingWork</code>(<code>:1257</code>)다. 마스터셋을 순회하며 EVICTED인 멤버를 MakeResident 목록에 담고, <strong>모든 멤버의 <code>LastGPUSyncPoint</code>와 <code>LastUsedTimestamp</code>를 갱신하고 LRU 꼬리로 보낸다</strong>. 선언 흐름의 최종 효과가 바로 이 갱신이다. 매 Submit마다 등록되는 리소스는 LRU 꼬리 쪽(최근 사용)에 계속 남아 evict 후보에서 벗어나고, 등록이 끊긴 리소스만 LRU 머리 쪽(가장 오래됨)에 고인다. 그다음이 트리밍인데, 상수 세 개가 정책의 전부다.
</p>

<div class="code-block"><div class="code-lang">C++ — d3dx12residency.h:688, :1625 (eviction 정책 상수와 유예 계산)</div>cMinEvictionGracePeriod(<span class="num">1.0f</span>),                  <span class="cm">// 최소 유예 1초</span>
cMaxEvictionGracePeriod(<span class="num">60.0f</span>),                 <span class="cm">// 최대 유예 60초</span>
cTrimPercentageMemoryUsageThreshold(<span class="num">0.7f</span>),      <span class="cm">// 예산의 70%부터 트리밍 시작</span>

<span class="kw">UINT64</span> <span class="ty">GetCurrentEvictionGracePeriod</span>(DXGI_QUERY_VIDEO_MEMORY_INFO* LocalMemoryState)
{
    <span class="kw">double</span> Pressure = <span class="kw">double</span>(CurrentUsage) / <span class="kw">double</span>(Budget);
    <span class="kw">if</span> (Pressure &gt; cTrimPercentageMemoryUsageThreshold)
    {
        <span class="cm">// 70%→100% 구간에서 유예를 60초→1초로 선형 축소</span>
        Pressure = (Pressure - <span class="num">0.7</span>) / (<span class="num">1.0</span> - <span class="num">0.7</span>);
        <span class="kw">return</span> <span class="kw">UINT64</span>((MaxTicks - MinTicks) * (<span class="num">1.0</span> - Pressure)) + MinTicks;
    }
    <span class="kw">return</span> MAXUINT64;  <span class="cm">// 70% 미만: 사실상 트리밍 안 함</span>
}</div>

<div class="scene-fig">
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="VRAM 사용률 대비 eviction 유예 시간 그래프. 70% 미만에서는 무한대이고 70%에서 60초로 시작해 100%에서 1초로 선형 감소한다">
<line x1="80" y1="240" x2="720" y2="240" stroke="#4b5563" stroke-width="1.5"/>
<line x1="80" y1="40" x2="80" y2="240" stroke="#4b5563" stroke-width="1.5"/>
<text x="30" y="150" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563" transform="rotate(-90 40 150)">eviction 유예</text>
<text x="380" y="282" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">VRAM 사용률 / 예산 (CurrentUsage ÷ Budget)</text>
<g font-family="Consolas, monospace" font-size="11" fill="#6b7484">
<text x="72" y="258">0%</text><text x="342" y="258">70%</text><text x="700" y="258">100%</text>
<text x="44" y="70">60s</text><text x="50" y="236">1s</text>
</g>
<line x1="352" y1="40" x2="352" y2="240" stroke="#d9a441" stroke-width="1.4" stroke-dasharray="5 4"/>
<rect x="80" y="40" width="272" height="200" fill="#2a9d8f" opacity="0.07"/>
<text x="120" y="90" font-family="Segoe UI, sans-serif" font-size="12.5" font-weight="700" fill="#2a9d8f">유예 = MAXUINT64</text>
<text x="120" y="110" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#4b8a82">aged eviction 없음</text>
<text x="120" y="128" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#4b8a82">(안 쓰는 것도 안 내린다)</text>
<path d="M 352 66 L 712 232" fill="none" stroke="#d6304a" stroke-width="2.5"/>
<circle cx="352" cy="66" r="4" fill="#d6304a"/><circle cx="712" cy="232" r="4" fill="#d6304a"/>
<text x="420" y="106" font-family="Segoe UI, sans-serif" font-size="12.5" font-weight="700" fill="#d6304a">압박이 클수록 "최근"의 기준이 짧아진다</text>
<text x="420" y="126" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#a3243a">사용률 85%면 유예 약 30초,</text>
<text x="420" y="144" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#a3243a">100%면 1초만 안 쓰여도 evict 후보</text>
<text x="360" y="56" font-family="Segoe UI, sans-serif" font-size="11" fill="#8a6716">← 70%: 트리밍 시작점</text>
</svg>
<div class="scene-cap">GetCurrentEvictionGracePeriod의 그래프. 70% 밑에서는 아무것도 내리지 않다가, 70%를 넘는 순간부터 압박에 비례해 유예가 60초에서 1초로 줄어든다. "VRAM 빠듯한 날에만 죽는" 크래시의 문턱값이 이 0.7이다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
정리 이야기로 넘어가기 전에 <strong>세대(generation)</strong>를 짚어야 한다. 뒤에 나올 두 정리가 모두 이 장치에 기대기 때문이다. <code>ResidencyManager</code>는 <code>CurrentSyncPointGeneration</code>이라는 카운터를 하나 들고 있고, <code>ExecuteCommandLists</code>가 한 번 돌 때마다 이 값을 1 올린다(<code>:1062</code>). 즉 <strong>세대 = 몇 번째 Submit인가</strong>다. 그리고 4단계에서 갱신한다고 한 <code>LastGPUSyncPoint</code>가 바로 <strong>"이 리소스가 마지막으로 등록된 세대"</strong>다. 세대마다 그 시점의 큐별 펜스 값을 묶어 <code>DeviceWideSyncPoint</code>로 남겨 두므로, "세대 N의 작업을 GPU가 다 끝냈는가"는 펜스를 읽어 바로 판정할 수 있다. 정리 코드가 하는 비교가 정확히 이것이다.
</p>

<div class="code-block"><div class="code-lang">C++ — d3dx12residency.h:634, :610 (두 정리의 안전 조건)</div><span class="cm">// aged eviction: GPU가 아직 그 세대를 돌고 있으면 손대지 않는다</span>
<span class="kw">if</span> ((MaxSyncPoint &amp;&amp; pObject-&gt;LastGPUSyncPoint &gt;= MaxSyncPoint-&gt;GenerationID)  <span class="cm">// 아직 안 끝난 세대</span>
    || CurrentTimeStamp - pObject-&gt;LastUsedTimestamp &lt;= MinDelta)                 <span class="cm">// 유예 안에 쓰였음</span>
    <span class="kw">break</span>;   <span class="cm">// LRU가 오래된 순으로 정렬돼 있으니, 여기서 멈추면 뒤는 볼 필요도 없다</span>

<span class="cm">// budget eviction: 완료를 기다린 세대까지만 밀어낸다</span>
<span class="kw">if</span> (pObject-&gt;LastGPUSyncPoint &gt; SyncPoint || CurrentUsage &lt; CurrentBudget)
    <span class="kw">break</span>;</div>

<p style="color:var(--text2);line-height:1.85;">
헷갈리기 쉬운 부분을 하나 정리해 두자. 세대로 판정하는 것은 <strong>"지금 쫓아내도 안전한가"</strong> 하나뿐이다. 이 리소스가 현재 evict된 상태인지 아닌지는 세대가 아니라 <code>ManagedObject</code>의 별도 필드인 <strong><code>ResidencyStatus</code></strong>(<code>RESIDENT</code> / <code>EVICTED</code>)가 들고 있다. 4단계가 마스터셋을 훑어 <code>EVICTED</code>인 멤버만 골라 <code>MakeResident</code> 목록에 담는다고 한 것이 이 필드를 보는 것이다. 정리하면 질문마다 보는 필드가 다르다. <strong>"무엇이 내려가 있나"는 <code>ResidencyStatus</code>로, "내려도 되나"는 세대로, "내릴 만큼 오래됐나"는 타임스탬프로 판정한다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
eviction은 두 갈래다. <strong>aged eviction</strong>(<code>TrimAgedAllocations</code>)은 매 Submit마다 도는 가벼운 정리로, LRU 머리부터 "GPU가 이미 다 쓴 것"이면서 "유예 시간보다 오래 안 쓰인 것"만 걷어 낸다. GPU를 기다리지 않는다. <strong>budget eviction</strong>(<code>TrimToSyncPointInclusive</code>)은 MakeResident할 자리가 없을 때만 발동하는 강제 정리로, 이때는 <code>WaitForSyncPoint</code>로 <strong>CPU가 GPU의 완료를 실제로 블록하며 기다린 뒤</strong> 그 세대까지 쓰인 것들을 밀어낸다. 프레임 스파이크가 나는 지점이다. 그마저 실패하면, 즉 커맨드리스트 하나가 요구하는 워킹셋 자체가 시스템이 감당 못 할 크기면 라이브러리는 예산을 무시하고 강행하며, 소스에는 이런 주석이 남아 있다: <code>"TODO: What should we do if this fails? This is a catastrophic failure in which the app is trying to use more memory in 1 command list than can possibly be made resident by the system."</code>
</p>

<p style="color:var(--text2);line-height:1.85;">
마지막으로 볼 것이 5단계 GPU 게이트다. MakeResident는 <code>ID3D12Device3::EnqueueMakeResident</code>로 OS 페이징 큐에 비동기로 걸리고, 완료 시 페이징 펜스(<code>AsyncThreadFence</code>)가 시그널된다. Submit 직전에 큐에 <code>Wait(페이징 펜스)</code>를 걸어 두므로, <strong>CPU는 페이징을 기다리지 않고 다음 일을 하러 가고 GPU만 자기 일감의 메모리가 준비될 때까지 대기</strong>한다. 이 게이트 덕분에 "등록된 리소스는 GPU가 읽는 시점에 반드시 resident"라는 계약이 성립한다. 뒤집어 말하면, 등록 안 된 리소스에게는 이 계약이 처음부터 없다.
</p>

<div class="callout callout-teal">
<div class="callout-title">디버깅 팁: 예산을 강제로 줄여서 재현하기</div>
이 크래시 부류의 고약한 점은 개발 머신(VRAM 넉넉)에서 재현이 안 된다는 것이다. 5.8에서 새로 추가된 <code>D3D12.ResidencyDebugBudgetMB</code>가 정확히 이 용도다(5.7 릴리스에는 없다. 도입 커밋 메시지부터 "CVar for stress testing residency manager"다). 예산을 강제로 128MB 따위로 낮추면 eviction과 MakeResident가 격렬하게 돌면서, 평소에는 "예산이 넉넉해 evict가 안 일어나서" 숨어 있던 <strong>UpdateResidency 누락이 즉시 페이지 폴트로 드러난다</strong>. cvar 도움말 원문도 "exposing missing UpdateResidency calls that would otherwise be hidden"이라고 쓴다. 유사품으로 <code>D3D12.EvictAllResidentResourcesInBackground</code>는 포커스를 잃은 앱의 예산을 0으로 만들어 VRAM을 통째로 반납하는 운영용 스위치다.
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">11 — GPU 실행과 페이지 폴트</span>
</div>

# 두 흐름이 어긋나면: 페이지 폴트를 읽는 법

<div class="research-post">
<div class="callout callout-info">
<div class="callout-title">언제 불리나: 전체 흐름의 ⑧과 그 이후</div>
실행은 GPU 타임라인에서 일어나고, 크래시의 감지와 리포트는 RHI 인터럽트 스레드가 맡는다. 이 장에서만 무대가 CPU 코드 밖으로 나간다.
</div>

<p style="color:var(--text2);line-height:1.85;">
GPU가 <code>DispatchRays</code>를 실행하는 순간을 그려 보자. ray가 삼각형에 맞고, 하드웨어가 05장의 산식으로 SBT 레코드 주소를 계산하고, 레코드의 식별자로 히트 셰이더를 띄우고, 셰이더가 레코드에서 시스템 파라미터를 읽어 <code>ResourceDescriptorHeap[인덱스]</code> 또는 GPU VA로 버텍스 버퍼에 접근한다. 이 접근에는 <strong>어떤 검증도 없다</strong>. 주소 변환 하드웨어가 페이지 테이블을 찾아볼 뿐이다. 그 리소스가 속한 32MiB 블록이 10장에서 evict된 상태라면 매핑이 없고, GPU 페이지 폴트가 난다. GPU는 이 폴트에서 복구하지 못한다. OS의 TDR<span class="fn-note"><input type="checkbox" id="fn-tdr" class="fn-toggle"><label for="fn-tdr" class="fn-ref">8</label><span class="fn-body"><strong>TDR(Timeout Detection and Recovery):</strong> GPU가 일정 시간(기본 2초) 안에 응답하지 않으면 OS가 드라이버를 강제 리셋하는 Windows의 안전장치. 앱 입장에서는 디바이스가 통째로 사라지는 것으로 보인다.</span></span>이 드라이버를 리셋하고, 앱에는 <code>DXGI_ERROR_DEVICE_REMOVED</code>(사유는 주로 <code>DXGI_ERROR_DEVICE_HUNG</code>)가 돌아온다.
</p>

<p style="color:var(--text2);line-height:1.85;">
언리얼이 이것을 감지하고 리포트하는 경로도 소스에 다 있다. RHI 인터럽트 스레드(<code>ProcessInterruptQueue</code>, <code>D3D12Submission.cpp:1064</code>)가 세 가지 신호로 크래시를 잡는다. 드라이버가 크래시 시 펜스를 <code>UINT64_MAX</code>로 시그널하는 것, <code>GetDeviceRemovedReason()</code>이 에러를 반환하는 것, Submit 후 5초(기본 <code>r.D3D12.SubmissionTimeout</code>) 내 완료가 안 되는 행(hang)이다. 잡히면 <code>OutputGPUCrashReport</code>가 리포트를 조립하는데, 페이지 폴트에서 중요한 것은 <strong>폴트가 난 GPU 가상 주소</strong>다. NVIDIA Aftermath의 <code>GPUFaultAddress</code>, 또는 D3D12 표준 기능인 DRED<span class="fn-note"><input type="checkbox" id="fn-dred" class="fn-toggle"><label for="fn-dred" class="fn-ref">9</label><span class="fn-body"><strong>DRED(Device Removed Extended Data):</strong> 디바이스 제거 시점의 자동 브레드크럼(어느 커맨드리스트의 몇 번째 오퍼레이션까지 완료됐나)과 페이지 폴트 정보를 드라이버가 남겨 주는 D3D12 진단 기능. 언리얼은 <code>-dred</code> 커맨드라인이나 <code>r.D3D12.DRED</code>로 켠다.</span></span>의 <code>GetPageFaultAllocationOutput</code>이 주는 <code>PageFaultVA</code>가 그것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
주소 하나만으로는 아무것도 알 수 없으니, 언리얼은 자체 할당 추적 DB(<code>D3D12.TrackAllAllocations</code>)로 3중 대조를 한다. <code>LogPageFaultData</code>(<code>D3D12Util.cpp:657</code>)가 폴트 주소 <strong>±16MB의 살아 있는 리소스</strong>, 주소를 포함하는 <strong>활성 힙</strong>, 그리고 <strong>최근 100프레임 안에 해제된 할당</strong>을 이름·크기·거리와 함께 출력한다. 주소를 직접 대조할 때 주의점이 하나 있다. 폴트 주소는 셰이더가 건드린 정확한 바이트가 아니라 GPU MMU가 관리하는 <strong>64KB 페이지의 시작 주소로 반올림</strong>되어 온다. "폴트 주소 − 리소스 시작"으로 블록 안 오프셋을 계산했다면 그 값은 정확한 지점이 아니라 64KB 창의 시작으로 읽어야 한다. 여기서 폴트의 두 시그니처가 갈린다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="페이지 폴트 주소를 3중 대조하는 진단 흐름. 활성 리소스에 잡히면 residency 등록 누락 의심, 최근 해제 목록에 잡히면 use-after-free 의심으로 갈린다">
<defs><marker id="pf-a" markerWidth="9" markerHeight="8" refX="7.5" refY="4" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="#6b7484"/></marker></defs>
<rect x="264" y="24" width="232" height="52" rx="8" fill="#fdeef0" stroke="#d6304a" stroke-width="2"/>
<text x="282" y="46" font-family="Consolas, monospace" font-size="12" font-weight="700" fill="#a3243a">PageFaultVA = 0x2'4012'8000</text>
<text x="282" y="66" font-family="Consolas, monospace" font-size="10.5" fill="#6b7484">DRED / Aftermath가 준 폴트 주소</text>
<path d="M 320 76 L 176 116" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#pf-a)"/>
<path d="M 380 76 L 380 116" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#pf-a)"/>
<path d="M 440 76 L 584 116" fill="none" stroke="#6b7484" stroke-width="1.6" marker-end="url(#pf-a)"/>
<rect x="40" y="120" width="230" height="88" rx="8" fill="#f3f6fb" stroke="#3b82c4" stroke-width="1.5"/>
<text x="56" y="144" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#1e3a5f">① 활성 리소스 ±16MB</text>
<text x="56" y="166" font-family="Consolas, monospace" font-size="10" fill="#4b5563">FindResourcesNearGPUAddress</text>
<text x="56" y="184" font-family="Consolas, monospace" font-size="10" fill="#6b7484">이름·크기·폴트까지 거리 출력</text>
<rect x="296" y="120" width="180" height="88" rx="8" fill="#f3f6fb" stroke="#8b5cf6" stroke-width="1.5"/>
<text x="312" y="144" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#443066">② 활성 힙</text>
<text x="312" y="166" font-family="Consolas, monospace" font-size="10" fill="#4b5563">FindHeapsContaining…</text>
<text x="312" y="184" font-family="Consolas, monospace" font-size="10" fill="#6b7484">어느 풀 블록인가</text>
<rect x="502" y="120" width="234" height="88" rx="8" fill="#f3f6fb" stroke="#d9a441" stroke-width="1.5"/>
<text x="518" y="144" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#8a6716">③ 최근 100프레임 해제분</text>
<text x="518" y="166" font-family="Consolas, monospace" font-size="10" fill="#4b5563">FindReleasedAllocationData</text>
<text x="518" y="184" font-family="Consolas, monospace" font-size="10" fill="#6b7484">해제 프레임·defrag 여부 출력</text>
<rect x="40" y="236" width="330" height="76" rx="8" fill="#fdeef0" stroke="#d6304a" stroke-width="1.5"/>
<text x="56" y="260" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#a3243a">활성 쪽에서 잡혔다면</text>
<text x="56" y="282" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#2b2f3d">리소스는 살아 있는데 접근 실패 = evict 의심.</text>
<text x="56" y="300" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#2b2f3d">이 글의 주제, residency 등록 누락 쪽이다</text>
<rect x="406" y="236" width="330" height="76" rx="8" fill="#fdf7ec" stroke="#d9a441" stroke-width="1.5"/>
<text x="422" y="260" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#8a6716">최근 해제 쪽에서 잡혔다면</text>
<text x="422" y="282" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#2b2f3d">use-after-free. SBT 레코드가 낡은 주소를 든 채</text>
<text x="422" y="300" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#2b2f3d">리소스가 해제·defrag된 경우 (07장의 리스너가 막는 것)</text>
</svg>
<div class="scene-cap">LogPageFaultData의 3중 대조와 두 시그니처. 함께 출력되는 LogMemoryStats의 예산/사용량으로 "폴트 시점에 메모리 압박이 있었는가"까지 교차 확인하면 원인 부류가 좁혀진다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 글의 시나리오, 즉 <strong>선언 누락 + evict</strong>는 첫 번째 시그니처로 나타난다. 리소스가 해제된 적이 없으므로 "Active objects with VA ranges that match the faulting VA" 목록에 멀쩡한 이름으로 잡히는데 GPU는 접근에 실패한 것이다. 그 순간 함께 찍히는 메모리 통계에서 사용량이 예산 근처(70% 이상)라면 원인은 이 부류로 좁혀진다. 반대로 "Recent freed objects" 쪽에 잡히면 07장의 리스너 체계가 막아야 했을 use-after-free 부류다. 마지막으로, evict된 리소스 접근을 <strong>크래시 전에</strong> 잡는 수단도 있다. D3D 디버그 레이어(<code>-d3ddebug</code>)는 ExecuteCommandLists 시점에 non-resident 리소스 참조를 에러로 뱉고, 10장의 <code>ResidencyDebugBudgetMB</code>는 넉넉한 개발 머신에서도 그 상황을 강제로 만들어 준다.
</p>

<div class="callout callout-teal">
<div class="callout-title">지름길: NVIDIA 카드라면 Aftermath가 덤프 한 장에서 시그니처를 갈라 준다</div>
Aftermath의 리소스 트래킹(<code>r.GPUCrashDebugging</code> 계열로 활성)을 켜 두면 드라이버가 리소스의 생성·파괴·evict를 전부 지켜보다가, 폴트 시점에 폴트 주소와 겹치는 리소스들을 <strong>상태 필드와 함께</strong> 덤프에 실어 준다. 그중 두 필드가 위의 두 시그니처와 1:1로 대응한다. <code>Residency: Evicted</code> + <code>Was Destroyed: False</code>라면 살아 있는 리소스의 매핑만 사라진 것, 즉 <strong>등록 누락 부류</strong>이고, <code>Was Destroyed: True</code>라면 use-after-free 부류다. 3중 대조 로그를 뒤지기 전에 첫 판정이 이 두 줄로 끝난다. 참고로 같은 폴트 주소에 후보 리소스가 여러 개 나열되는 것(<code>Resource 0/N</code>)은 버그가 아니라 GPU 가상 주소가 재사용되기 때문이다. 그 자리에 있다가 파괴된 옛 리소스들이 함께 나오므로, <code>Was Destroyed: False</code>인 항목이 지금 문제가 된 리소스다.
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">정리</span>

</div>

# 정리

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
정리하자. WDDM은 GPU 메모리를 가상화했고, 그 결과가 작업관리자의 80GB다. 대신 프로그래머가 해줘야 할 일이 하나 생겼다. <strong>이번 Submit에서 어떤 리소스를 쓰는지 residency 매니저에 직접 알려야 한다.</strong> 언리얼의 레이트레이싱은 이 일을 두 흐름으로 나눠 처리한다. 주소는 SBT 레코드에 한 번만 기록하고(데이터 흐름), 그 주소가 가리키는 리소스는 매 Submit마다 다시 등록한다(선언 흐름). 크래시가 나는 조건도 여기서 그대로 나온다. <strong>레코드에는 주소가 남아 있는데 등록이 끊긴 리소스가 있고, VRAM 사용량이 예산의 70%를 넘어 그 리소스가 evict되는 순간이다.</strong>
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">두 흐름</div>
<div class="card-title">기록은 한 번, 등록은 매번</div>
<div class="card-desc">주소는 바인딩 때 레코드에 기록되고(06장), residency 등록은 디스패치마다 ResidencySet에 쌓인다(09장). 서로 다른 코드 경로라 한쪽만 살아남을 수 있다는 것이 크래시의 근원이다.</div>
</div>
<div class="card teal">
<div class="card-label">4~64 MiB</div>
<div class="card-title">residency의 단위는 블록</div>
<div class="card-desc">버퍼는 풀 블록에서 서브할당되고(기본 버퍼 풀 32MiB, 업로드 힙 4MiB, 텍스처 풀 64MiB) residency 핸들은 블록에 하나다. MakeResident도 Evict도 블록 단위. 씬 추적의 핸들 dedup이 이 구조를 최적화로 되쓴다.</div>
</div>
<div class="card coral">
<div class="card-label">0.7f · 60s→1s</div>
<div class="card-title">예산 70%가 문턱이다</div>
<div class="card-desc">사용률 70% 미만에서는 아무것도 안 내린다. 70%를 넘으면 유예가 60초에서 1초로 선형 축소되고, 자리가 모자라면 GPU 완료를 기다려서라도 강제 evict한다. "빠듯한 날에만 죽는" 이유.</div>
</div>
<div class="card gold">
<div class="card-label">PageFaultVA</div>
<div class="card-title">폴트에는 시그니처가 있다</div>
<div class="card-desc">활성 리소스 목록에 잡히면 등록 누락 + evict, 최근 해제 목록에 잡히면 use-after-free. TrackAllAllocations와 DRED/Aftermath, 그리고 예산을 조이는 ResidencyDebugBudgetMB가 진단 도구다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
마지막으로 이 글의 핵심 숫자들만 모아 두자. 작업관리자의 GPU 메모리 = 전용 VRAM + 시스템 RAM의 절반. 레코드 = 식별자 32B + 시스템 파라미터 32B(Config·IB오프셋·FirstPrimitive·UserData + IB/VB의 인덱스 또는 주소 union) + 루트 CBV 8B×N, stride는 32B 정렬. 세그먼트당 레코드 2줄(머티리얼/섀도). 풀 블록 32MiB(기본 버퍼 풀 기준. 업로드 힙 4MiB·텍스처 풀 64MiB), 풀행 문턱 16MiB. 트리밍 문턱 0.7, 유예 1~60초, 파이프라인 깊이 6, 동시 ResidencySet 1,024개. 그리고 bindless에서 레코드에 직접 기록되는 인덱스는 시스템 IB/VB 둘뿐이며, 셰이더의 register 없는 선언은 컴파일러 rewriter가 <code>ResourceDescriptorHeap[레코드의 루트 상수]</code>로 바꿔 쓴다. 이 파이프라인의 나머지 절반, 즉 레코드 줄 번호를 계산해 셰이더를 띄우는 GPU 쪽 이야기는 <a href="/raytracing-shader">레이트레이싱 셰이더 글</a>에서 이어진다.
</p>

<span class="section-eyebrow">참고</span>

<div class="card-grid" style="grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));">
<div class="card blue">
<div class="card-label">이론 배경</div>
<div class="card-title">Microsoft — D3D12 Residency</div>
<div class="card-desc"><a href="https://learn.microsoft.com/windows/win32/direct3d12/residency">learn.microsoft.com — Residency</a>. MakeResident/Evict의 계약, 예산과 QueryVideoMemoryInfo. WDDM 메모리 가상화는 같은 사이트의 GPU virtual memory 문서. 라이브러리 원본은 <a href="https://github.com/microsoft/DirectX-Graphics-Samples/tree/master/Libraries/D3DX12Residency">DirectX-Graphics-Samples의 D3DX12Residency</a>.</div>
</div>
<div class="card purple">
<div class="card-label">사양</div>
<div class="card-title">DirectX Raytracing (DXR) Functional Spec</div>
<div class="card-desc"><a href="https://microsoft.github.io/DirectX-Specs/d3d/Raytracing.html">microsoft.github.io — Raytracing.html</a>. SBT 레코드 레이아웃(식별자 32B + 로컬 루트 인자), 히트그룹 레코드 주소 산식, 정렬 규칙(레코드 32B/테이블 64B)의 원전.</div>
</div>
<div class="card teal">
<div class="card-label">엔진 소스</div>
<div class="card-title">언리얼엔진 5.8 (5.8.0-release)</div>
<div class="card-desc"><code>d3dx12residency.h</code>(ThirdParty), <code>D3D12Residency.h</code>, <code>D3D12Resources.h/.cpp</code>, <code>D3D12PoolAllocator.cpp</code>, <code>D3D12Allocation.cpp</code>, <code>D3D12RayTracing.cpp/.h</code>, <code>D3D12RayTracingResources.h</code>, <code>D3D12CommandList.cpp</code>, <code>D3D12Submission.cpp</code>, <code>D3D12Util.cpp</code>, <code>RayTracingShaderBindingTable.cpp</code>, <code>RayTracingHitGroupCommon.ush</code>, <code>PlatformBindlessResources.ush</code>, <code>D3DShaderCompiler.cpp</code>. 이 글의 모든 코드 인용의 1차 출처.</div>
</div>
<div class="card gold">
<div class="card-label">진단 도구</div>
<div class="card-title">DRED · Aftermath · 디버그 cvar</div>
<div class="card-desc">DRED는 <a href="https://microsoft.github.io/DirectX-Specs/d3d/DeviceRemovedExtendedData.html">DirectX-Specs의 DRED 문서</a>, NVIDIA <a href="https://developer.nvidia.com/nsight-aftermath">Nsight Aftermath SDK</a>. 언리얼 쪽 스위치: <code>-dred</code>, <code>-gpucrashdebugging</code>, <code>D3D12.TrackAllAllocations</code>, <code>D3D12.ResidencyDebugBudgetMB</code>(5.8), <code>D3D12.ResidencyManagement</code>.</div>
</div>
</div>
</div>
