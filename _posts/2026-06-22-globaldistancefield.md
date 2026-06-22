---
layout: post
title: "UE5 Global Distance Field: 메시 SDF를 합쳐 월드를 레이마칭하다"
icon: paper
permalink: globaldistancefield
categories: Rendering
tags: [Rendering, Lumen, UnrealEngine]
excerpt: "Mesh Distance Field의 생성부터 Global Distance Field 합성, 클립맵 갱신, sphere tracing과 실제 활용까지"
back_color: "#ffffff"
img_name: "globaldistancefield.png"
toc: false
show: true
new: true
series: -1
index: 7
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - “Mesh Distance Field랑 Global Distance Field가 같은 거 아냐?”가 헷갈리는 분
> - 수천 개의 메시 SDF가 어떻게 씬 하나짜리 distance field로 합쳐지는지 궁금한 분
> - Lumen·DFAO·소프트 섀도우가 레이를 어떻게 “싸게” 쓰는지(소프트웨어 레이트레이싱)를 코드 수준에서 알고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - 메시 하나당 만들어지는 **로컬 SDF**가 어떻게 빌드·저장되는지(`8³` 브릭, narrow band, 아틀라스)
> - 그 로컬 SDF들이 왜 “글로벌”이 되는지 — 여러 메시 중 **가장 가까운 거리만 골라 합치는 과정**
> - 카메라 중심 **클립맵** 구조와, 매 프레임 전체를 다시 굽지 않는 **Toroidal 스크롤 갱신**
> - **핵심** — GDF를 **스피어 트레이싱(sphere tracing)**으로 레이마칭해 월드를 표현·처리하는 방법
> - 이 레이마칭을 실제로 쓰는 곳(Lumen 소프트웨어 RT, Distance Field AO, MegaLights)
> - 행진하지 않는 쓰임 — **single sample**(거리 1회)과 **gradient**(표면 법선)로 파티클 충돌·머티리얼 효과를 처리하는 법

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">

<style>
.gdf-post {
  --bg2: #f4f6fb;
  --surface: #f9fafd;
  --surface2: #eceef7;
  --border: rgba(60,80,180,0.10);
  --border2: rgba(60,80,180,0.22);
  --text: #1a1d2e;
  --text2: #464c6a;
  --text3: #8890aa;
  --accent: #3d63e0;
  --teal: #0a8f62;
  --gold: #b07d00;
  --coral: #d63031;
}
.gdf-post .eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin: 56px 0 4px;
}
.gdf-post .grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin: 24px 0;
}
.gdf-post .card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
  color: var(--text2);
  font-size: 13px;
  line-height: 1.65;
}
.gdf-post .card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--accent);
}
.gdf-post .card.teal::before { background: var(--teal); }
.gdf-post .card.gold::before { background: var(--gold); }
.gdf-post .card.coral::before { background: var(--coral); }
.gdf-post .card strong {
  display: block;
  color: var(--text);
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 6px;
}
.gdf-post .card code { font-size: 12px; }
.gdf-post .note {
  border-radius: 12px;
  padding: 16px 20px;
  margin: 20px 0;
  border: 1px solid rgba(61,99,224,0.18);
  border-left: 3px solid var(--accent);
  background: rgba(61,99,224,0.05);
  color: var(--text2);
  font-size: 13px;
  line-height: 1.75;
}
.gdf-post .note > strong:first-child {
  display: block;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.gdf-post .note > strong:first-child + br { display: none; }
.gdf-post .note.warn {
  border-color: rgba(176,125,0,0.20);
  border-left-color: var(--gold);
  background: rgba(176,125,0,0.05);
}
.gdf-post .note.warn > strong:first-child { color: var(--gold); }
.gdf-post .note.teal {
  border-color: rgba(10,143,98,0.20);
  border-left-color: var(--teal);
  background: rgba(10,143,98,0.05);
}
.gdf-post .note.teal > strong:first-child { color: var(--teal); }
.gdf-post table {
  display: block;
  width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 24px 0;
  font-size: 13px;
}
.gdf-post th {
  min-width: 130px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  background: var(--surface2);
  color: var(--accent);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: left;
}
.gdf-post td {
  min-width: 130px;
  padding: 9px 14px;
  border: 1px solid var(--border);
  color: var(--text2);
  text-align: left;
  line-height: 1.65;
}
.gdf-post tr:nth-child(even) td { background: var(--surface); }
.gdf-post table code { font-size: 12px; }
.gdf-post div.highlighter-rouge,
.gdf-post figure.highlight,
.gdf-post .highlight,
.gdf-post .highlight code {
  background: #1e2230;
  color: #c8d0ea;
  border-radius: 12px;
}
.gdf-post div.highlighter-rouge,
.gdf-post figure.highlight {
  border: 1px solid rgba(120,140,200,0.15);
  margin: 18px 0;
  overflow: hidden;
}
.gdf-post .highlight pre,
.gdf-post pre.highlight {
  padding: 20px 22px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  line-height: 1.85;
  color: #c8d0ea;
  border-radius: 12px;
}
.gdf-post .diagram {
  margin: 24px 0;
  padding: 16px 12px 12px;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
.gdf-post .diagram svg {
  width: 100%;
  min-width: 620px;
  display: block;
  margin: 0 auto;
  font-family: 'JetBrains Mono', monospace;
}
.gdf-post .caption {
  margin: 9px 0 0;
  color: var(--text3);
  font-size: 12px;
  line-height: 1.7;
  text-align: center;
}
</style>

<div class="gdf-post" markdown="1">

<span class="eyebrow">00 — 개요</span>

# Global Distance Field 개요

Distance Field(Signed Distance Field, SDF)는 공간의 각 점에 대해 **가장 가까운 표면까지의 부호 있는 거리**를 저장한 것이다. 표면 밖이면 양수, 안이면 음수, 표면 위면 0이다. 단지 이 한 값만 있으면, 그 점에서 어느 방향으로든 그 거리만큼은 부딪힐 게 없다는 강력한 기하 보장을 얻는다. UE5의 Lumen·Distance Field AO·소프트 섀도우·파티클 충돌이 GPU에서 “레이를 싸게 쏘는” 비결이 바로 이 한 줄에서 나온다.

Unreal은 이 SDF를 두 층위로 다룬다. 하나는 **메시 하나하나에 대해 오프라인에 구워 두는 Mesh Distance Field(MDF)**, 다른 하나는 그것들을 런타임에 카메라 주변으로 합성한 **Global Distance Field(GDF)**다. 이 글은 MDF가 어떻게 만들어지는지에서 출발해, 그것이 왜 “글로벌”로 합쳐지는지, 그리고 핵심인 **합성된 GDF를 스피어 트레이싱(sphere tracing)으로 레이마칭해 월드를 표현·처리하는 방법**까지 UE 5.7 소스를 따라 분석한다.

<div class="note"><strong>먼저 던지는 질문</strong><br>“메시 디스턴스 필드가 그냥 글로벌 디스턴스 필드 아닌가?” 거의 맞지만 1:1 변환이 아니라 <strong>합성(composite)</strong>이다. 글로벌은 메시 SDF들을 재료로 삼아, 카메라 주변 볼륨의 각 지점에서 가장 가까운 표면까지의 거리만 골라 모아 굽는다. 이름이 갈리는 이유부터 짚고 간다. <strong>로컬(메시 1개) vs 글로벌(씬 전체).</strong></div>

<span class="eyebrow">01 — 재료</span>

# Mesh Distance Field: 로컬 SDF라는 재료

GDF를 이해하려면 그 재료인 MDF부터 봐야 한다. MDF는 **스태틱 메시 하나당 하나씩**, 메시 빌드(쿡) 시점에 비동기 DDC 태스크로 구워진다(`FAsyncDistanceFieldTask`, `DistanceFieldAtlas.cpp:231`). 실제 생성은 `MeshDistanceFieldUtilities.cpp`에서 Embree BVH 위에서 일어난다.

<div class="grid">
  <div class="card"><strong>거리 크기<br>Embree point query</strong>각 복셀에서 <code>rtcPointQuery</code>로 가장 가까운 삼각형 위의 점을 찾는다(<code>ClosestPointOnTriangleToPoint</code>). 반경을 줄여 가며 최근접점을 구해 거리의 절댓값을 얻는다.</div>
  <div class="card gold"><strong>부호(안/밖)<br>백페이스 레이 투표</strong>복셀에서 사방으로 레이를 쏴(<code>rtcIntersect1</code>) 뒷면(backface)을 맞힌 비율로 안쪽인지 판정한다. <code>HitBack &gt; 0.25 * NumSamples</code>면 내부이며, point-query 코드에서 반구당 약 49방향을 쓴다.</div>
  <div class="card teal"><strong>해상도<br>크기에 비례</strong><code>VoxelDensity(0.2) × ResolutionScale</code>로 복셀 밀도를 정하고 메시 바운드 크기에 따라 그리드 차원을 잡는다. <code>r.DistanceFields.MaxPerMeshResolution=256</code>으로 상한을 둔다.</div>
</div>

## 저장: `8³` 브릭 · narrow band · 8비트

구워진 SDF는 희소(sparse) 브릭 볼륨으로 저장된다. 볼륨을 `8³` 브릭으로 자르되(`BrickSize=8`), 실제 고유 복셀은 7개이고 8번째 한 겹은 트라이라이니어 필터링용 공유 경계다(`UniqueDataBrickSize=7`, `DistanceFieldAtlas.h:39-41`). 포맷은 복셀당 1바이트(`PF_G8`)다.

```cpp
// 거리는 narrow band 안에서만 의미 있다. BandSizeInVoxels = 4
// 8비트 값: [-MaxDist, +MaxDist] 구간을 [0, 255]로 양자화
float VolumeSpaceDistance = ...;                 // 부호 있는 거리(볼륨 공간)
float Rescaled = (VolumeSpaceDistance - Bias.Y) / Bias.X;
Brick[VoxelIndex] = round(saturate(Rescaled) * 255); // 밴드 밖은 0/255로 포화
```

<div class="note warn"><strong>왜 narrow band(±4복셀)만 정확한가</strong><br>SDF의 쓸모는 “표면 근처에서 정확한 거리”다. 표면에서 멀어지면 8비트로는 어차피 정밀도가 낮고, 레이마칭도 큰 보폭으로 건너뛰면 되니 정밀할 필요가 없다. 그래서 ±4복셀(<code>BandSizeInVoxels=4</code>) 밖은 포화시킨다. 이 “밴드”라는 개념은 GDF에서도 그대로 이어진다.</div>

브릭은 표면이 지나가는 것만 저장한다. 균일하게 비었거나(전부 밖) 꽉 찬(전부 안) 브릭은 버리고, indirection table에 `InvalidBrickIndex(0xFFFFFFFF)`를 적는다. 즉 메시 SDF는 **표면 껍질 주변의 브릭들 + “어디에 어떤 브릭이 있나”를 가리키는 인다이렉션 테이블**로 이루어진 희소 구조다. Mip은 3단계이고 최저해상도 mip은 항상 로드, 나머지는 스트리밍된다(`NumMips=3`).

## 로컬 공간 + GPU 오브젝트 버퍼

결정적으로, 이 SDF는 메시의 **로컬(“Volume”) 공간**에 저장된다. 최대 변이 `[-1, 1]`에 들어오도록 정규화된다(`LocalToVolumeScale = 1 / 바운드 최대변`). 그래서 같은 메시를 100번 배치해도 SDF 데이터는 아틀라스에 단 한 벌이면 된다. 인스턴스마다 다른 건 변환행렬뿐이다.

그 “인스턴스마다 다른 변환”을 GPU에 들고 있는 게 `FDistanceFieldObjectBuffers`다. 씬의 각 DF 오브젝트에 대해 월드→볼륨(`WorldToVolume`) 행렬, 볼륨→월드, 부호, 그리고 아틀라스의 어떤 브릭들을 쓰는지(`AssetState` 인덱스)를 담는다(`DistanceFieldObjectManagement.cpp:659-706`). 그리고 모든 메시의 브릭은 하나의 공유 브릭 아틀라스(`PF_G8` 3D 텍스처, XY 128×128 브릭 고정, Z로 성장, 최대 약 256MB)에 모인다.

<div class="note"><strong>여기까지가 “로컬”</strong><br>한 메시의 SDF는 자기 로컬 공간에서만 의미 있다. 월드 어디에 있는지, 옆 메시와 어떻게 겹치는지는 전혀 모른다. “이 점에서 씬 전체의 가장 가까운 표면이 얼마나 머냐”를 한 번에 답하려면 이 로컬 조각들을 월드 공간으로 모아야 한다. 그게 다음 장의 글로벌이다.</div>

<span class="eyebrow">02 — 로컬 → 글로벌</span>

# 왜 “글로벌”인가

대비되는 건 “메시(=로컬)”다. 메시 SDF가 한 오브젝트에 국한된 distance field라면, 글로벌 SDF는 **씬 전체를 아우르는 월드 공간 distance field**다. 한 점에서 “이 점이 속한 메시”가 아니라 “씬에서 가장 가까운 아무 표면”까지의 거리를 한 번의 샘플로 답한다.

| 구분 | Mesh Distance Field | Global Distance Field |
|---|---|---|
| 범위 | 메시 1개(local) | 씬 전체(global) |
| 공간 | 메시 로컬 “Volume” 공간 | 월드 공간(카메라 중심 클립맵) |
| 시점 | 오프라인 베이크(쿡) | 런타임 매 프레임 합성 |
| 해상도 | 높음(정확) | 낮음(근사, 멀수록 거침) |
| 저장 | `8³` 브릭 아틀라스 + indirection | 클립맵 페이지 아틀라스(`R8`) |
| 쓰임 | 정밀 메시 단위 트레이스 | 씬 전체를 1회 트레이스(싸다) |

즉 GDF는 MDF를 재료로 삼아 만들어진다. “메시 SDF로 만들어진다”는 말은 맞다. 다만 여러 메시의 로컬 SDF를 카메라 주변 월드 볼륨에 모아서 하나로 머지하고 다운샘플하기 때문에, 원본 MDF보다 흐릿하고 디테일이 깎인다. 그 머지의 정체는 의외로 단순하다. **공간의 각 지점에서 주변 메시들까지의 거리 중 가장 가까운(최소) 값만 골라 적는 것**이다.

<div class="diagram">
<svg viewBox="0 0 760 250" role="img" aria-label="여러 메시의 로컬 SDF가 월드 공간의 Global Distance Field로 합성되는 과정">
  <defs>
    <marker id="gdf-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#8890aa"/></marker>
    <pattern id="gdf-grid" width="13" height="13" patternUnits="userSpaceOnUse"><path d="M13 0H0V13" fill="none" stroke="#8890aa" stroke-width=".5" opacity=".32"/></pattern>
  </defs>
  <g font-size="11" fill="#464c6a" text-anchor="middle">
    <g transform="translate(85,42)">
      <rect width="120" height="120" rx="8" fill="url(#gdf-grid)" stroke="#3d63e0"/>
      <circle cx="60" cy="60" r="24" fill="#3d63e0" fill-opacity=".08" stroke="#3d63e0" stroke-width="2"/>
      <circle cx="60" cy="60" r="37" fill="none" stroke="#3d63e0" stroke-dasharray="3 3" opacity=".55"/>
      <text x="60" y="141">Mesh A · local SDF</text>
    </g>
    <g transform="translate(260,42)">
      <rect width="120" height="120" rx="8" fill="url(#gdf-grid)" stroke="#0a8f62"/>
      <path d="M33 83L58 34 91 90Z" fill="#0a8f62" fill-opacity=".08" stroke="#0a8f62" stroke-width="2"/>
      <path d="M20 96L55 20 106 104" fill="none" stroke="#0a8f62" stroke-dasharray="3 3" opacity=".55"/>
      <text x="60" y="141">Mesh B · local SDF</text>
    </g>
    <path d="M210 102H244" stroke="#8890aa" stroke-width="1.5" marker-end="url(#gdf-arrow)"/>
    <path d="M391 102H445" stroke="#8890aa" stroke-width="1.5" marker-end="url(#gdf-arrow)"/>
    <text x="417" y="91" fill="#b07d00">WorldToVolume</text>
    <g transform="translate(460,27)">
      <rect width="220" height="150" rx="9" fill="url(#gdf-grid)" stroke="#d63031" stroke-width="1.5"/>
      <circle cx="71" cy="68" r="23" fill="#3d63e0" fill-opacity=".09" stroke="#3d63e0"/>
      <path d="M125 105L151 52 185 112Z" fill="#0a8f62" fill-opacity=".09" stroke="#0a8f62"/>
      <path d="M24 126C53 91 80 101 102 123C123 143 153 139 199 121" fill="none" stroke="#d63031" stroke-width="2"/>
      <text x="110" y="170">GDF voxel = min(dA, dB, ...)</text>
    </g>
    <rect x="173" y="208" width="414" height="28" rx="14" fill="#f1f3f9" stroke="#d9ddea"/>
    <text x="380" y="226" font-weight="700">로컬 좌표 샘플 → 월드 복셀마다 최솟값 합성</text>
  </g>
</svg>
<p class="caption">각 GDF 복셀은 후보 메시의 로컬 SDF를 샘플한 뒤 가장 작은 거리만 저장한다.</p>
</div>

<div class="note teal"><strong>합집합까지의 거리 = 가장 가까운 거리</strong><br>한 지점에서 의자까지 80cm, 벽까지 30cm, 바닥까지 120cm라고 하자. 그러면 “씬에서 가장 가까운 표면”은 당연히 벽(30cm), 즉 셋 중 가장 작은 거리다. GDF 합성은 이 자명한 성질을 그대로 쓴다. 한 복셀에서 주변 메시들까지의 거리를 모두 재고 그중 가장 작은 값만 적는다. 그래서 수천 개의 “로컬” 거리가 하나의 “글로벌” 거리로 접힌다. 코드에서는 이 “가장 작은 값 고르기”를 HLSL 내장 함수 <code>min</code>으로 한다.</div>

<span class="eyebrow">03 — 클립맵</span>

# 클립맵: 카메라 중심의 중첩 박스

월드 전체를 균일한 고해상도 볼륨으로 담는 건 불가능하다. 그래서 GDF는 **클립맵(clipmap)**, 카메라를 중심으로 한 중첩된 큐브들을 쓴다. 안쪽 클립맵은 작고 촘촘하게, 바깥 클립맵은 넓고 거칠게. 가까운 곳은 정밀하게, 먼 곳은 대충. 밉맵을 3D 월드 공간으로 옮긴 셈이다.

<div style="overflow-x:auto;margin:26px 0;">
<svg viewBox="0 0 700 430" role="img" aria-label="카메라 중심으로 중첩된 클립맵 큐브의 단면" style="width:100%;max-width:680px;display:block;margin:0 auto;font-family:'JetBrains Mono',monospace;">
  <line x1="174" y1="205" x2="526" y2="205" stroke="#8890aa" stroke-width="1" stroke-dasharray="3 4" opacity="0.35"/>
  <line x1="350" y1="29" x2="350" y2="381" stroke="#8890aa" stroke-width="1" stroke-dasharray="3 4" opacity="0.35"/>
  <rect x="174" y="29" width="352" height="352" fill="#d63031" fill-opacity="0.035" stroke="#d63031" stroke-width="2"/>
  <rect x="262" y="117" width="176" height="176" fill="#b07d00" fill-opacity="0.04" stroke="#b07d00" stroke-width="2"/>
  <rect x="306" y="161" width="88" height="88" fill="#0a8f62" fill-opacity="0.05" stroke="#0a8f62" stroke-width="2"/>
  <rect x="328" y="183" width="44" height="44" fill="#3d63e0" fill-opacity="0.06" stroke="#3d63e0" stroke-width="2"/>
  <rect x="186" y="40" width="44" height="44" fill="none" stroke="#8890aa" stroke-width="1.2" stroke-dasharray="4 3"/>
  <text x="208" y="34" text-anchor="middle" font-size="10" fill="#8890aa">1 voxel</text>
  <rect x="330" y="186" width="9" height="9" fill="none" stroke="#8890aa" stroke-width="1" stroke-dasharray="3 2"/>
  <circle cx="350" cy="205" r="6" fill="#1a1d2e"/>
  <circle cx="350" cy="205" r="2.4" fill="#ffffff"/>
  <g font-size="12" font-weight="700" text-anchor="middle" style="paint-order:stroke;stroke:#ffffff;stroke-width:3px;">
    <text x="350" y="22" fill="#d63031">Clipmap 3</text>
    <text x="350" y="110" fill="#b07d00">Clipmap 2</text>
    <text x="350" y="154" fill="#0a8f62">Clipmap 1</text>
    <text x="350" y="176" fill="#3d63e0">Clipmap 0</text>
  </g>
  <g font-size="11" font-weight="600" text-anchor="middle" fill="#464c6a" style="paint-order:stroke;stroke:#ffffff;stroke-width:3px;">
    <text x="350" y="241">±E</text><text x="350" y="263">±2E</text>
    <text x="350" y="307">±4E</text><text x="350" y="397">±8E</text>
  </g>
  <g transform="translate(628,64)" stroke="#8890aa" stroke-width="1.3" stroke-linejoin="round">
    <polygon points="0,-24 21,-12 0,0 -21,-12" fill="#eef0f7"/>
    <polygon points="-21,-12 0,0 0,24 -21,12" fill="#e2e6f2"/>
    <polygon points="21,-12 0,0 0,24 21,12" fill="#f6f8fd"/>
  </g>
  <text x="628" y="104" text-anchor="middle" font-size="10" fill="#8890aa">정육면체 볼륨</text>
</svg>
<p style="text-align:center;font-size:12px;color:#8890aa;margin:8px 0 0;line-height:1.7;">◉ 카메라 = 모든 클립맵의 <strong>공통 중심</strong> · 그림은 정육면체 클립맵을 가로로 자른 <strong>단면(cross-section)</strong><br>레벨마다 범위(extent)가 <strong>×2</strong>로 커지고, 해상도(128³)는 같아 <strong>바깥 클립맵일수록 voxel이 커진다(거칠다)</strong></p>
</div>

```cpp
// 클립맵은 레벨마다 월드 범위가 2배씩 커진다(Exponent = 2).
float GetClipmapExtent(int32 ClipmapIndex, ...)
{
    return InnerClipmapDistance
         * pow(GAOGlobalDFClipmapDistanceExponent, ClipmapIndex);
}

// 클립맵당 거리 크기
ClipmapVoxelSize = (2 * ClipmapExtent) / ClipmapResolution; // 기본 해상도 128
ClipmapInfluenceRadius = 4 * ClipmapVoxelSize;              // narrow band = 4복셀
```

<div class="grid">
  <div class="card"><strong>개수<br>기본 4, 최대 6</strong><code>r.AOGlobalDistanceField.NumClipmaps=4</code>, 상한 <code>MaxClipmaps=6</code>. Lumen이 켜지면 먼 뷰 거리를 덮으려고 1~2개 더 붙는다.</div>
  <div class="card teal"><strong>해상도<br>클립맵당 `128³`</strong><code>r.AOGlobalDFResolution=128</code>. 페이지 단위(7복셀)의 배수로 반올림된다. Lumen은 자체 해상도를 쓴다.</div>
  <div class="card gold"><strong>중심<br>항상 카메라</strong>모든 클립맵이 카메라를 중심으로 같이 따라온다. 카메라가 움직이면 박스도 같이 미끄러진다. 05장의 스크롤.</div>
</div>

각 클립맵은 다시 **페이지(page)** 단위로 쪼개진다(페이지 = `7³` 복셀, 아틀라스에서는 경계 포함 `8³`). 그리고 표면 근처 페이지만 실제로 할당된다. 텅 빈 하늘 같은 영역엔 페이지를 안 만든다. 이건 VT/VSM에서 본 “필요한 것만 적재한다”는 같은 철학이고, 클립맵 UV→물리 페이지를 잇는 페이지 테이블(`PF_R32_UINT`) 인다이렉션도 동일한 구조다.

<span class="eyebrow">04 — 합성</span>

# 합성: 가장 가까운 거리만 골라 월드를 굽는다

이제 02장의 “가장 가까운 거리만 고르기”가 실제로 어떻게 도는지 본다. 한 복셀이 주변 메시 전부를 순회하면 비싸므로, **두 단계 컬링으로 “이 복셀 근처에 영향 주는 메시”만** 추려낸다. `UpdateGlobalDistanceFieldVolume()`이 클립맵마다 아래 컴퓨트 패스들을 순서대로 디스패치한다.

<div class="grid">
  <div class="card"><strong>PASS 1 · CullToClipmap</strong>씬 DF 오브젝트를 클립맵 박스로 1차 컬링한다. 작은 메시 제외.</div>
  <div class="card"><strong>PASS 2·3 · CullToGrid</strong>클립맵 볼륨을 4페이지짜리 셀 그리드로 쪼개 메시를 분배한다.</div>
  <div class="card gold"><strong>PASS 4 · AllocatePages</strong>영향권에 메시가 있는 dirty 페이지만 free list에서 할당한다.</div>
  <div class="card teal"><strong>PASS 5 · Composite</strong>복셀마다 주변 메시 중 가장 가까운 거리를 페이지 아틀라스에 기록한다.</div>
</div>

핵심은 마지막 `CompositeObjectsIntoPagesCS`다. 스레드 하나 = 복셀 하나. 그 복셀이 속한 셀 그리드에서 영향권(`InfluenceRadius`) 안에 드는 메시들만 추려, 각 메시까지의 거리를 재고 그중 가장 가까운(최소) 값을 남긴다.

<div class="note teal"><strong>한 복셀이 값을 정하는 법(숫자로)</strong><br>어떤 복셀 주변에 의자·벽·바닥이 있다고 하자. 각 메시의 거리를 재면 의자 80, 벽 30, 바닥 120. 이 복셀이 저장할 값은 “씬에서 가장 가까운 표면까지 거리”이므로 가장 작은 30(벽)이다. 코드는 일단 큰 값(<code>InfluenceRadius</code>)으로 시작해 메시를 하나씩 보며 더 가까운 게 나올 때마다 값을 갱신한다. 마지막에 남는 게 곧 최솟값이다.</div>

```hlsl
MinDistance = InfluenceRadius;        // 일단 “아주 멀다”로 시작
MinDistance = min(MinDistance, 80);   // 의자 → 80
MinDistance = min(MinDistance, 30);   // 벽 → 30(더 가까움, 갱신)
MinDistance = min(MinDistance, 120);  // 바닥 → 그대로 30
// 이 복셀이 갖는 값 = 가장 가까운 표면(벽)까지의 거리
```

```hlsl
void CompositeMeshSDF(inout float MinDistance,
                      uint ObjectIndex, float3 WorldP, ...)
{
    // 이 메시의 로컬 SDF를 월드 좌표 P에서 샘플(다음 코드블록)
    float DistanceToOccluder = DistanceToNearestSurfaceForObject(
        ObjectIndex, WorldP, InfluenceRadius);
    MinDistance = min(MinDistance, DistanceToOccluder); // 핵심 = 최소거리
}

// 복셀 루프가 끝나면 누적된 최소거리를 인코딩해 페이지 아틀라스에 기록
RWPageAtlasTexture[PageAtlasCoord] =
    EncodeGlobalDistanceFieldPageDistance(MinDistance, InfluenceRadius);
```

그리고 여기가 **로컬→글로벌의 다리**다. `DistanceToNearestSurfaceForObject`는 월드 좌표 `P`를 그 메시의 `WorldToVolume` 행렬로 로컬 공간으로 되돌린 뒤, 01장에서 구운 그 메시의 브릭 아틀라스를 트라이라이니어 샘플한다. 즉 글로벌 복셀이 거꾸로 각 메시의 로컬 공간으로 들어가 SDF를 읽어오는 것이다.

```hlsl
float DistanceToNearestSurfaceForObject(uint ObjectIndex,
                                        float3 WorldP, float MaxDist)
{
    FDFObjectData Obj = LoadDFObjectData(ObjectIndex);
    float3 VolumeP = mul(float4(WorldP, 1), Obj.WorldToVolume).xyz;

    // indirection table → 브릭 인덱스 → 공유 아틀라스 UV → 8비트 거리
    float d = SampleSparseMeshSignedDistanceField(VolumeP, Obj.AssetState);
    return d * Obj.VolumeToWorldScale; // 다시 월드 스케일로
}
```

복셀에 적히는 값은 `[0,1]`로 정규화된 부호 있는 거리다. `0.5`가 정확히 표면, 그보다 작으면 안쪽, 영향권(±narrow band) 밖이면 `1.0`으로 포화한다. 이 `1.0`이 곧 “이 근처엔 표면 없음”의 sentinel이라 샘플러가 무효로 거른다.

```hlsl
// 부호거리 → [0,1]. 0.5 = 표면, <0.5 = 내부, 1.0 = 밴드 밖(무효)
float EncodeGlobalDistanceFieldPageDistance(float Distance, float InfluenceRange)
{ return saturate(Distance / (2.0f * InfluenceRange) + 0.5f); }

float DecodeGlobalDistanceFieldPageDistance(float Encoded, float InfluenceRange)
{ return (Encoded * 2.0f - 1.0f) * InfluenceRange; }
```

## 두 개의 곁가지 — Mip과 캐시 레이어

<div class="grid">
  <div class="card"><strong>Mip(먼 거리용)<br>5번의 Eikonal 전파</strong>희소 페이지를 멀리서 마칭하면 비싸다. 그래서 클립맵마다 저해상도 full mip(<code>MipFactor=4</code>, <code>PF_R8</code>)을 따로 둔다. <code>PropagateMipDistanceCS</code>가 Eikonal 방정식을 5스텝 풀어 밴드 거리를 빈 공간으로 흘려보내 어디서나 유효한 거친 거리를 만든다.</div>
  <div class="card gold"><strong>캐시 레이어<br>정적 / 동적 분리</strong>정적 메시는 <code>GDF_MostlyStatic</code> 레이어에, 움직이는 메시는 <code>GDF_Full</code> 레이어에 따로 합성한 뒤 두 레이어 중 가까운 거리로 겹친다. 움직이는 물체가 바뀌어도 Full 레이어만 다시 구우면 되므로 정적 부분 계산을 재활용한다(<code>CacheMostlyStaticSeparately=1</code>).</div>
</div>

지형(Landscape)은 메시 SDF가 아니라 높이장이므로 따로 합성된다. `ComposeHeightfieldsIntoPagesCS`가 높이+노멀을 읽어 평면까지의 거리(`dot(Normal, P - SurfacePos)`)를 계산해 같은 페이지 아틀라스에 합친다. 역시 메시 거리와 비교해 더 가까운 쪽을 남긴다. 결국 메시든 지형이든 **“가장 가까운 표면까지의 거리”라는 한 값**으로 통일된다.

<span class="eyebrow">05 — 점진적 갱신</span>

# Toroidal 스크롤: 매 프레임 다시 굽지 않는다

클립맵은 카메라를 따라다닌다. 카메라가 1m 움직였다고 `128³` 볼륨을 통째로 다시 구우면 감당이 안 된다. UE5는 OS 가상메모리/VT의 스크롤과 같은 트릭, **Toroidal(도넛 모양 wraparound) 주소**로 새로 드러난 얇은 판(slab)만 다시 굽는다.

<div class="note"><strong>용어 — Toroidal & slab</strong><br>Toroidal은 “도넛(torus) 모양”이라는 뜻이다. 볼륨의 끝을 넘어가면 반대쪽 끝으로 감기는(wraparound) 주소 방식, 즉 1D ring buffer의 3D 버전이다. 덕분에 카메라가 움직여도 voxel을 메모리에서 밀어 옮기지 않고 “원점이 어디인가”만 바꾸면 된다. slab은 볼륨에서 잘라낸 두께 얇은 판(슬라이스)이다. 카메라가 한 방향으로 움직이면 진행면에 두께 1페이지짜리 얇은 판이 새로 노출되는데, 다시 구워야 할 곳은 이 slab뿐이고 나머지는 손대지 않는다.</div>

<div class="note warn"><strong>① 페이지 그리드에 스냅</strong><br>카메라 위치를 <code>ClipmapPageSize</code> 단위로 반올림해 클립맵 중심을 잡는다(<code>GlobalDistanceField.cpp:1124</code>). 페이지 경계에 맞춰야 볼륨을 재활용할 수 있다.</div>

<div class="note warn"><strong>② 움직인 만큼의 slab만 dirty</strong><br>이동한 축마다 새로 노출된 얇은 판(slab)만 업데이트 영역으로 추가한다(<code>AddUpdateBoundsForAxis</code>). 앞으로 가면 앞면, 뒤로 가면 뒷면. 그 사이 움직인 오브젝트의 바운드도 영향반경만큼 확장해 dirty로 표시한다.</div>

<div class="diagram">
<svg viewBox="0 0 760 265" role="img" aria-label="카메라 이동 시 클립맵 전체가 아니라 새로 드러난 slab만 갱신하는 Toroidal 스크롤">
  <defs><marker id="scroll-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#3d63e0"/></marker><pattern id="page-grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#8890aa" stroke-width=".7" opacity=".45"/></pattern></defs>
  <g font-size="11" fill="#464c6a" text-anchor="middle">
    <text x="175" y="20" font-weight="700">Frame N</text><text x="585" y="20" font-weight="700">Frame N+1</text>
    <rect x="55" y="35" width="240" height="180" fill="url(#page-grid)" stroke="#464c6a" stroke-width="1.5"/>
    <circle cx="175" cy="125" r="6" fill="#1a1d2e"/><path d="M175 125H215" stroke="#3d63e0" stroke-width="2" marker-end="url(#scroll-arrow)"/>
    <rect x="465" y="35" width="240" height="180" fill="url(#page-grid)" stroke="#464c6a" stroke-width="1.5"/>
    <rect x="645" y="35" width="60" height="180" fill="#d63031" fill-opacity=".10" stroke="#d63031" stroke-width="2"/>
    <circle cx="615" cy="125" r="6" fill="#1a1d2e"/>
    <path d="M315 125H438" stroke="#3d63e0" stroke-width="2" marker-end="url(#scroll-arrow)"/>
    <text x="376" y="111" fill="#3d63e0">camera +2 pages</text>
    <text x="675" y="126" fill="#d63031" font-weight="700" transform="rotate(-90 675 126)">dirty slab만 재합성</text>
    <path d="M465 230C505 250 665 250 705 230" fill="none" stroke="#0a8f62" stroke-width="1.5"/>
    <text x="585" y="260" fill="#0a8f62">기존 페이지는 ScrollOffset으로 재사용</text>
  </g>
</svg>
<p class="caption">클립맵 데이터를 복사하지 않는다. 주소를 감고 이동 방향에서 새로 노출된 얇은 면만 dirty 처리한다.</p>
</div>

<div class="note teal"><strong>③ Toroidal로 감아 넣는다</strong><br>복셀을 물리적으로 옮기는 대신 <code>ScrollOffset</code>만 기록한다. <code>ScrollOffsetInPages %= ClipmapSizeInPages</code>로 감싸고(FP drift 방지), 샘플러는 <code>frac()</code>로 wrap한다. 클립맵은 도넛처럼 돌아 스크롤되어 들어온 slab만 새로 채워진다.</div>

```hlsl
// 월드 위치 → 클립맵 볼륨 UV. frac()이 wraparound를 만든다.
float3 ComputeGlobalUV(float3 TranslatedWorldP, uint ClipmapIndex)
{
    float4 AddMul = GlobalVolumeTranslatedWorldToUVAddAndMul[ClipmapIndex];
    float3 UV = frac(TranslatedWorldP * AddMul.www + AddMul.xyz);
    return frac(UV); // frac(-eps) = 1.0 쪽으로 한 바퀴
}
```

<div class="note"><strong>예산을 나눠 쓴다</strong><br>그래도 한 프레임에 모든 클립맵을 갱신하면 부담이라, 스태거(staggered) 업데이트로 프레임당 <code>r.AOGlobalDistanceFieldClipmapUpdatesPerFrame=2</code>개만 갱신한다. 큰(먼) 클립맵일수록 더 드물게 갱신해도 티가 안 난다. 한 프레임에 움직인 오브젝트 바운드가 1024개를 넘으면 그 클립맵은 부분갱신을 포기하고 풀 갱신으로 전환한다.</div>

<span class="eyebrow">06 — 핵심</span>

# 핵심: SDF를 레이마칭해 월드를 본다

여기까지가 “월드를 하나의 distance field로 굽는” 과정이었다. 이제 이 글의 핵심, **그 distance field로 레이를 쏴서 월드를 표현·처리하는 방법**이다. 삼각형도, BVH도, 하드웨어 RT 코어도 없이 GPU는 거리 한 값만 반복해서 읽으며 월드를 가로지른다. 이 기법이 **스피어 트레이싱(sphere tracing)**이다.

## 왜 거리 하나로 레이를 쓸 수 있나

SDF가 점 `p`에서 돌려주는 값 `f(p)`는 “가장 가까운 표면까지의 거리”다. 그러면 `p`를 중심으로 반지름 `f(p)`인 구(球) 안에는 어떤 표면도 없다. 방향과 무관하게 가장 가까운 표면이 이미 `f(p)`만큼 떨어져 있으니까. 따라서 레이 위에서 `f(p)`만큼은 무엇도 건너뛸 걱정 없이 한 번에 전진할 수 있다.

<div class="diagram">
<svg viewBox="0 0 760 260" role="img" aria-label="SDF가 보장하는 빈 구의 반지름만큼 레이가 전진하는 sphere tracing">
  <defs><marker id="trace-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#3d63e0"/></marker></defs>
  <g font-size="11" fill="#464c6a">
    <path d="M650 25C612 54 626 78 600 103C574 128 610 158 579 189C557 211 571 232 548 248L735 248 735 25Z" fill="#d63031" fill-opacity=".06" stroke="#d63031" stroke-width="2"/>
    <line x1="45" y1="205" x2="665" y2="96" stroke="#3d63e0" stroke-width="2" marker-end="url(#trace-arrow)"/>
    <g fill="none" stroke="#8890aa" stroke-width="1.3">
      <circle cx="120" cy="192" r="70"/><circle cx="260" cy="167" r="66"/><circle cx="386" cy="145" r="55"/><circle cx="488" cy="127" r="39"/><circle cx="558" cy="114" r="25"/><circle cx="601" cy="107" r="13"/>
    </g>
    <g fill="#1a1d2e"><circle cx="120" cy="192" r="3.5"/><circle cx="260" cy="167" r="3.5"/><circle cx="386" cy="145" r="3.5"/><circle cx="488" cy="127" r="3.5"/><circle cx="558" cy="114" r="3.5"/><circle cx="601" cy="107" r="3.5"/></g>
    <g text-anchor="middle"><text x="120" y="209">p₀</text><text x="260" y="184">p₁</text><text x="386" y="162">p₂</text><text x="488" y="144">p₃</text><text x="601" y="91" fill="#d63031" font-weight="700">hit</text></g>
    <text x="48" y="28" font-weight="700">f(p) = 가장 가까운 표면까지의 거리 = 안전하게 전진할 수 있는 보폭</text>
  </g>
</svg>
<p class="caption">각 원은 현재 점에서 표면과 만나지 않는 빈 구다. 표면에 가까워질수록 보폭이 자연스럽게 줄어든다.</p>
</div>

전진해 다시 샘플하면 또 그만큼의 빈 구를 얻는다. 이걸 반복하면 레이는 **빈 구의 표면으로 점프 → 재샘플 → 또 점프**를 하며 나아간다. 표면에 가까워질수록 `f(p) → 0`이라 보폭이 저절로 줄어 부드럽게 수렴하고, `f(p)`가 충분히 작아지면 “맞았다(hit)”고 선언한다. 표면을 절대 뚫고 지나치지 않는, 보장된 행진이다.

## 행진의 실체 — `RayTraceGlobalDistanceField`

호출하는 쪽이 보는 모습은 단 두 줄이다. `SetupGlobalSDFTraceInput`으로 레이를 정의만 포장하고(시작점·방향·trace 구간·보폭 계수), `RayTraceGlobalDistanceField`에 넘긴다. 행진은 전부 두 번째 함수 안에서 일어나고, 결과로 히트 정보(`HitTime`, `HitClipmapIndex`)가 돌아온다.

```hlsl
// 1) 레이 정의만 포장 — 아직 아무것도 쏘지 않는다
FGlobalSDFTraceInput TraceInput = SetupGlobalSDFTraceInput(
    TStart, RayDir, MinTraceDistance, MaxDistance, StepFactor, MinStepFactor);

// 2) 이 안에서 sphere tracing 루프가 돌며 히트 결과 반환
FGlobalSDFTraceResult R = RayTraceGlobalDistanceField(TraceInput);
if (GlobalSDFTraceResultIsHit(R)) { /* R.HitTime, R.HitClipmapIndex 사용 */ }
```

<div class="note"><strong>이게 ray marching이다</strong><br><code>SetupGlobalSDFTraceInput</code>은 레이를 기술할 뿐 한 걸음도 내딛지 않는다. 실제로 레이를 쏘는 것, 즉 ray marching은 <code>RayTraceGlobalDistanceField</code> 내부 루프다. 더 정확히는 보폭이 고정이 아니라 매 스텝 distance field 값(빈 구 반지름)만큼 적응적으로 전진하는 sphere tracing이다. <code>StepFactor(&lt;1)</code>는 보폭을 살짝 보수적으로 줄이는 계수일 뿐 본질은 그대로다.</div>

그 두 번째 함수 안을 펼치면 **바깥 루프(클립맵: 안→밖) + 안쪽 루프(스피어 트레이스: 최대 256스텝)**의 이중 구조가 나온다. 안쪽 루프가 앞의 직관을 그대로 코드로 옮긴 것이다.

```hlsl
const uint MaxSteps = 256;
for (; StepIndex < MaxSteps; ++StepIndex)
{
    float3 P = RayStart + RayDirection * SampleRayTime;

    // ① 항상 상주하는 저해상도 Mip에서 거리 1회(싸다)
    float MipValue = SampleGlobalMip(P, ClipmapIndex);
    float DistanceField = Decode(MipValue, MipInfluenceRange);

    // ② 표면 근처 + 페이지가 할당돼 있으면 page atlas로 정밀화
    FPage Page = GetGlobalDistanceFieldPage(P, ClipmapIndex);
    if (Page.bValid && MipValue < GlobalDistanceFieldMipTransition)
        DistanceField = Decode(SamplePageAtlas(P, Page), ClipmapInfluenceRange);

    // ③ 히트 판정 — 표면까지 거리보다 확장량이 크게 들어오면
    if (DistanceField < ExpandSurfaceAmount)
    {
        TraceResult.HitTime = max(
            SampleRayTime + DistanceField - ExpandSurfaceAmount, 0);
        TraceResult.HitClipmapIndex = ClipmapIndex;
        break;
    }

    // ④ 전진 — 가장 가까운 표면까지의 거리만큼 점프(empty-sphere step)
    float StepDistance = max(DistanceField * StepFactor, MinStepSize);
    SampleRayTime += StepDistance;
    if (SampleRayTime > ClipmapExitTime) break; // 이 클립맵 벗어나면 다음 레벨로
}
```

이 루프에서 눈여겨볼 네 가지가 있다.

<div class="note"><strong>① 2단계 샘플 — Mip 먼저, 페이지는 필요할 때만</strong><br>매 스텝 먼저 항상 상주하는 저해상도 Mip(04장)을 읽는다. 싸고 어디서나 유효하다. 표면이 가까워(<code>MipValue &lt; MipTransition</code>) 정밀도가 필요할 때만 희소 페이지 아틀라스를 한 번 더 읽는다. 먼 빈 공간에서는 페이지를 건드리지 않고 큰 보폭으로 날아간다.</div>

<div class="note"><strong>② 전진 — `max(dist * StepFactor, MinStepSize)`</strong><br>빈 구의 반지름만큼 전진하되 두 가지 보정이 있다. <code>StepFactor(&lt;1)</code>로 살짝 보수적으로 가는데, 글로벌 SDF는 물체 밖 거리를 과대평가하는 경향이 있어 풀 거리로 뛰면 표면을 새어 지나갈 수 있기 때문이다. <code>MinStepSize</code>는 평평하거나 밴드가 0인 구간에서 멈추지 않도록 보장하는 최소 보폭이다.</div>

<div class="note"><strong>③ 히트 임계가 고정 epsilon이 아니다 — 표면 확장</strong><br>히트 기준 <code>ExpandSurfaceAmount</code>는 상수가 아니라 레이가 멀리 갈수록 커지는 동적 임계다. 가까이선 0에 가까워 자기 표면 오검출을 막고, 멀리선 표면을 “살찌워” 얇은 나뭇잎·울타리 같은 기하를 레이가 새어 통과하는 leak을 막는다.</div>

<div class="note"><strong>④ 바깥 루프 — 클립맵 핸드오프</strong><br>안쪽 256스텝이 현재 클립맵 박스를 다 썼으면 바깥 루프가 다음(더 큰) 클립맵으로 넘긴다. 이전 클립맵이 닿지 못한 바깥 구간부터 이어서 행진한다. 그래서 레이는 가까운 곳은 고해상도로, 먼 곳은 저해상도로 정밀도를 거리에 맞춰 가로지른다.</div>

## 월드 점 → 클립맵 → UV

매 스텝의 위치 `P`는 먼저 자신을 담는 **가장 작은 클립맵**으로 매핑된다. 안쪽부터 훑어 경계에서 최소 1복셀 이상 안쪽에 들어오는 첫 클립맵을 고른다. Toroidal 경계 바로 옆은 필터링이 어긋나므로 피한다.

```hlsl
for (uint i = 0; i < NumGlobalSDFClipmaps; i++)
{
    float d = ComputeDistanceFromBoxToPointInside(Center[i], Extent[i], P);
    if (d > Extent[i].w * GlobalVolumeTexelSize) // 1복셀 이상 안쪽
    { FoundClipmapIndex = i; break; }             // 가장 작은(정밀한) 클립맵 선택
}
```

고른 클립맵 안에서 `P`는 `ComputeGlobalUV`(05장의 Toroidal `frac`)로 볼륨 UV가 되고, 그 UV로 페이지 테이블을 로드해 물리 페이지를 찾은 뒤, 페이지 안 소수부 + 아틀라스 오프셋으로 최종 아틀라스 UV를 만들어 거리를 샘플한다. 한 점에서 단순히 “씬까지의 거리”만 알고 싶을 땐 행진 없이 `GetDistanceToNearestSurfaceGlobal` 한 번이면 된다. 가장 정밀한 클립맵부터 시도하고, 무효면 거친 클립맵으로 폴백한다.

## Distance Field로 그림자와 AO를 — cone tracing

스피어 트레이싱의 부산물이 하나 더 있다. 매 스텝의 거리 `f(p)`는 곧 “반지름 `f(p)`의 빈 구”이고, 이건 광채 콘(cone)의 반경이기도 하다. 거리/콘반경 비율이 그 지점의 가시율이 되어 추가 레이 없이 부드러운 그림자와 AO가 나온다.

```hlsl
for (uint StepIndex = 0; StepIndex < NumSteps; ++StepIndex)
{
    float Dist = max(0, SampleGlobalDistanceField(P + Normal * CurrentDistance, ...));
    Occlusion += W * Dist / CurrentDistance; // 표면거리/콘반경 = 그 스텝의 가시율
    W *= 0.5f;                               // 가까운 샘플에 가중
    CurrentDistance *= StepScale;            // 다음 방향으로 기하급수 전진
}
return saturate(Occlusion / TotalW);          // 가려진 정도
```

같은 원리로 Lumen의 소프트 섀도우는 콘 각도를 키워 가며(`ConeStartRadius + TanConeAngle * RayTime`) 행진하고, 06장에서 본 `ExpandSurfaceAmount`가 그 콘의 “살찌우기”에 대응한다. 거리 한 값이 가시성·차폐·그림자를 한꺼번에 떠받친다.

<span class="eyebrow">07 — 소비자</span>

# 누가 이 레이마칭을 쓰는가

GDF 레이마칭은 UE5의 여러 시스템이 하드웨어 RT 없이 월드를 질의하는 공통 기반이다. 셰이더 전역 검색으로 확인한 주 소비자는 다음과 같다.

| 소비자 | 무엇을 하는가 | 방식 |
|---|---|---|
| Lumen 소프트웨어 RT | HWRT가 없거나 먼 거리(far field)일 때의 GI/반사 트레이싱. `ConeTraceLumenScene`이 카드→하이트필드→글로벌 SDF 복셀 순으로 입성 | `RayTraceGlobalDistanceField`(행진) |
| Lumen Radiosity / 반투명 볼륨 / 라디언스 캐시 | 2차 바운스·반투명·캐시 갱신용 트레이싱 | 같은 콘 트레이스 진입점 |
| MegaLights | 다수 광원의 소프트웨어 레이트레이싱 그림자 | GDF 행진 |
| Distance Field AO | 중·원거리 앰비언트 오클루전 | 콘 AO(`SampleGlobalDistanceField`) |
| Volumetric Fog | 하늘 차폐(sky occlusion), froxel에서 위로 45° 콘 | 콘 트레이스(행진) |
| 파티클 충돌 | GPU 파티클의 씬 충돌 + 충돌면 노멀 | single sample·gradient → 08장 |

<div class="note"><strong>글로벌 vs 메시 — 역할 분담</strong><br>Lumen은 가까운 물체는 per-object 메시 SDF(<code>RayTraceSingleMeshSDF</code>, 최대 64스텝)로 정밀 트레이스하고, 먼 거리·전역 폴백은 글로벌 SDF로 처리한다. 둘은 <code>ConeTraceLumenScene</code>에서 자연스럽게 이어 붙는다. 정밀이 필요한 곳은 로컬, 넓게 훑는 곳은 글로벌. 01~02장의 “로컬과 글로벌”이 트레이싱 단계에서 다시 한 번 역할을 나눠 갖는다.</div>

<span class="eyebrow">08 — 그 외 용도</span>

# Ray marching이 아닌 쓰임 — single sample · gradient

지금까지는 “레이가 어디서 표면에 닿나”를 찾는 ray marching이었다. 하지만 distance field의 또 다른 큰 쓰임은 **행진 없이 값을 딱 한 번만 읽는 것**이다. “이 점이 표면에서 얼마나 떨어졌나(거리)” 또는 “어느 방향에 표면이 있나(gradient)”만 알면 되는 경우다. 가시성·라이팅이 아니라 충돌·근접 효과 쪽이다.

<div class="note warn"><strong>“클립맵 루프 = ray marching”이 아니다</strong><br><code>GetDistanceToNearestSurfaceGlobal(Shared.ush:214)</code>에도 <code>for</code>가 있지만, 이건 레이를 따라 전진하는 루프가 아니다. 단지 그 점을 담는 가장 정밀한 클립맵을 찾는 순회(보통 4개)일 뿐이고, 유효한 페이지를 만나면 트라이라이니어 샘플 단 한 번 후 <code>break</code>한다. 06장의 sphere trace 루프(레이 방향으로 256스텝 전진)와는 완전히 다르다.</div>

## Single sample — 거리 한 번 읽기

<div class="note teal"><strong>파티클 충돌(Cascade · Niagara)</strong><br>GPU 파티클이 자기 위치에서 GDF 거리를 한 번 읽어 <code>거리 &lt; 반지름</code>이면 충돌로 판정한다(<code>ParticleSimulationShader.usf:470</code>). 매 프레임 파티클당 거리 1회, 행진이 없으니 수만 개도 싸다. Niagara는 이를 “Collision Query” 데이터 인터페이스로 그래프에 노출한다(<code>NiagaraDataInterfaceCollisionQuery.ush:214</code>).</div>

<div class="note teal"><strong>머티리얼 노드 `DistanceToNearestSurface`</strong><br>머티리얼에서 이 노드를 쓰면 픽셀 위치의 “가장 가까운 표면까지 거리”를 한 번 샘플한다. 컴파일러가 그대로 <code>GetDistanceToNearestSurfaceGlobal(P)</code>를 emit한다(<code>HLSLMaterialTranslator.cpp:12181</code>). <code>1 - saturate(거리/폭)</code> 같은 식으로 remap하면 표면 근접 마스크가 되어 물가 거품(shoreline foam), 눈·먼지 쌓임, 표면 주변 디졸브·역장(force field) 효과에 쓴다.</div>

<div class="note teal"><strong>Lumen Radiance Cache 프로브 배치</strong><br>Lumen은 라디언스 캐시 프로브가 지오메트리 안에 박히지 않게 후보 위치들의 거리를 각각 한 번씩 읽어, 표면에서 가장 멀리 떨어진 곳으로 프로브를 밀어낸다(<code>LumenRadianceCache.usf:228-240</code>). 역시 점 질의일 뿐 행진이 아니다.</div>

## Gradient — 표면의 “방향” 한 번 읽기

거리값의 기울기 `∇f`는 “거리가 가장 빠르게 커지는 방향”, 즉 가장 가까운 표면에서 멀어지는 방향이다. 참 SDF는 `|∇f| = 1`(Eikonal)이라 `normalize(∇f)`는 곧 그 지점의 표면 법선 근사가 된다. UE는 이를 **6-tap 중앙차분(central difference)**으로 구한다. 각 축의 ±half-voxel 위치에서 거리를 샘플해 차를 낸다.

```hlsl
float3 GlobalDistanceFieldPageCentralDiff(float3 UV, uint ClipmapIndex)
{
    float3 H = 0.5f * GlobalVolumeTexelSize; // ±half-voxel
    float R = SampleClipmap(UV + float3(+H.x, 0, 0), ClipmapIndex);
    float L = SampleClipmap(UV + float3(-H.x, 0, 0), ClipmapIndex);
    float F = SampleClipmap(UV + float3(0, +H.y, 0), ClipmapIndex);
    float B = SampleClipmap(UV + float3(0, -H.y, 0), ClipmapIndex);
    float U = SampleClipmap(UV + float3(0, 0, +H.z), ClipmapIndex);
    float D = SampleClipmap(UV + float3(0, 0, -H.z), ClipmapIndex);
    return float3(R - L, F - B, U - D); // 중앙차 = ∇f
}
```

<div class="note"><strong>충돌 반응 — 어느 쪽으로 튕길지</strong><br>파티클이 충돌하면 gradient가 곧 충돌면의 법선이 된다(<code>ParticleSimulationShader.usf:475</code>). 표면 점은 <code>위치 - 법선 × 거리</code>로 복원하고, 그 평면 기준으로 속도를 수직·접선 성분으로 나눠 resilience(반발)·friction(마찰)로 다시 합쳐 튕긴다. 거리 1번 + gradient 1번으로 충돌과 반사를 모두 처리한다.</div>

<div class="note"><strong>법선 재구성 — 머티리얼 노드</strong><br>머티리얼 <code>DistanceFieldGradient</code> 노드는 <code>GetDistanceFieldGradientGlobal(P)</code>를 emit해 “표면을 향하는 방향” 벡터를 준다(normalize는 사용자 몫). Lumen은 소프트웨어 트레이스가 hit한 지점의 법선을 per-mesh gradient(<code>CalculateMeshSDFGradient</code>)로 재구성하고, 비균일 스케일을 위해 <code>WorldToVolume</code>의 전치(=역전치)로 변환한다(<code>LumenSoftwareRayTracing.ush:298</code>).</div>

<div class="note"><strong>머티리얼 노드 하나가 GDF를 켠다</strong><br>머티리얼에 <code>DistanceToNearestSurface</code>/<code>DistanceFieldGradient</code> 노드를 놓으면 <code>bUsesGlobalDistanceField = true</code>가 머티리얼 relevance로 전파되어 그 프레임의 GDF 클립맵 빌드 자체를 강제한다(<code>DistanceFieldAmbientOcclusion.cpp:777</code>). 즉 single sample 한 번을 위해서도 04~05장의 합성 파이프라인이 돌아야 한다. 전제는 프로젝트의 “Generate Mesh Distance Fields” 활성화다.</div>

<div class="note warn"><strong>헷갈리기 쉬운 경계 — Volumetric Fog는 여기 아니다</strong><br>Volumetric Fog도 GDF를 쓰지만 single sample이 아니라 cone tracing이다. 하늘 차폐(sky occlusion)를 위해 froxel에서 위쪽으로 45° 콘을 <code>SampleGlobalDistanceField</code>로 행진시킨다(<code>VolumetricFog.usf:652</code>). 거리를 한 번 읽는 게 아니라 콘을 따라 여러 번 읽으므로 07장(ray marching) 쪽이다.</div>

<span class="eyebrow">09 — 정리</span>

# 정리

Global Distance Field는 **“가장 가까운 표면까지의 거리”라는 단 하나의 값으로 월드를 표현하고, 그 값을 반복해 읽으며 레이를 행진시킨다.**

<div class="grid">
  <div class="card"><strong>재료 — 로컬<br>Mesh Distance Field</strong>메시마다 로컬 공간에 구운 `8³` 브릭 SDF. narrow band(±4복셀)만 8비트로 정확히, 표면 근처 브릭만 희소 저장. 공유 아틀라스 + 인스턴스 `WorldToVolume`.</div>
  <div class="card teal"><strong>합성 — 글로벌<br>가장 가까운 거리로 굽는 클립맵</strong>카메라 중심 중첩 클립맵의 복셀마다 주변 메시 중 가장 가까운 거리를 모은다. 정적/동적 분리, Toroidal 스크롤로 새 slab만 갱신, 먼 거리용 Eikonal mip.</div>
  <div class="card coral"><strong>처리 — 레이마칭<br>스피어 트레이싱</strong>빈 구의 반지름만큼 전진하며 표면으로 수렴. Mip 먼저·페이지는 필요할 때만, 동적 표면 확장으로 leak 방지. 클립맵을 안→밖으로 핸드오프. 거리비로 콘 AO·소프트 섀도우까지.</div>
</div>

그래서 “메시 디스턴스 필드가 글로벌 디스턴스 필드 아니냐”는 질문의 답은 **재료는 같지만 층위가 다르다**. 로컬 SDF들을 “가장 가까운 거리만 고르기”로 접어 씬 하나짜리 distance field로 만들고, 그 위를 스피어 트레이싱으로 행진하는 순간 Unreal은 삼각형 없이도 월드 전체를 향해 레이를 쏠 수 있게 된다. Lumen·DFAO·MegaLights가 모두 이 한 장 위에 서 있다.

</div>
