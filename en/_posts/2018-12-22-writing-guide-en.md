---
title: Writing guide
date: 2018-12-22
lang: en
ref: writing-guide
tags:
- tutorial
interactive: true
threejs: true
shader: true
---

![](<../images/write.jpg>)
image from [link](<https://studybreaks.com/culture/nanowrimo-step-up-your-writing-game/>)

> This is a writing guide for [newgamedev.github.io](<https://newgamedev.github.io>) contributors.

&nbsp;
## Basic markdown usage

This homepage uses Jekyll based Github pages. Github pages support the markdown generator [kramdown](<https://github.com/gettalong/kramdown>) [since May 1st, 2016](<https://blog.github.com/2016-02-01-github-pages-now-faster-and-simpler-with-jekyll-3-0/>).

This is an overview of the grammar frequently used in kramdown. For further information, refer to [github help page](<https://help.github.com/articles/basic-writing-and-formatting-syntax/>), [kramdown official guide](<https://kramdown.gettalong.org/syntax.html>).

### Header

When you write subheadings, they automatically take positions in the table of contents at the top of the page.

```nil
# h1
## h2
### h3
#### h4
##### h5
###### h6
```

### Emphasis

You can use _italic_, __bold__, ___bold and italic___, ~~line through~~.

```nil
_italic_
__bold__
___bold and italic___
*italic*
**bold**
***bold and italic***
~~line through~~
```

### Links and images

You can include [links](<https://newgamedev.github.io/writing-guide/>) and images using the similar grammar. If you want to include images without any words, put `!` before the link. The sentence in the link will be written in alt(alternative string).

```nil
[text](<link address>)
![alt text](<image address>)
```

### Code

To indicate an `inline code`, put single quotation marks(\`) around the code. You can define a code by using \`. and also by typing  `~`  three times, and the code, and then another `~~~`, line by line, so that the code stays between the two `~~~` in the upper and lower lines. Github pages use [rouge](<https://github.com/jneen/rouge>) to automatically apply syntax highlighting. Most of the times it usually works without specifying the language, but to ensure you get an intended result, specifying the language is highly recommended.

You can also create a code block by using four spaces, but in this case you cannot designate the language for syntax highlighting .

```nil
`inline code`
~~~ javascript
console.log('code block');
~~~
```

### Blockquote (Quotation)

By typing `>` at the front of the line, you can make an blockquote. If you type `>` more than twice, you can make a nested blockquote.

```nil
> blockquote
>> nested blockquote
>> nested blockquote
> blockquote
```

### List

To make an unordered list, put `*`, `+`, `-` at the beginning of the line. To make an ordered list, put `1.`, `2.`, etc. at the beginning of the line.

```nil
* un
+ ordered
- list

1. ordered
2. list
```

### Checklist

- [x] You can add a checkbox in a checklist.
- [ ] Put x in the bracket for the checked item.

```nil
- [x] checked
- [ ] unchecked
```

### Footnote

You can add footnotes at the end of the page. You can designate numbers `[^1]`, `[^2]` by yourself, or you can make the numbering automatic by using `[^n]`.

```nil
footnote[^n]
[^n]: foot note description
```


&nbsp;
## MathJax usage guide

This homepage has been Forked at [texts.github.io](<https://texts.github.io/>) where [MathJax](<https://www.mathjax.org/>) is used for math expressions.

Basic math expressions and those frequently used are as follows. For further information, refer to the summary of [Typesetting Math in Texts](<https://texts.github.io/typesetting-math-in-texts/>), [stackexchange-mathematics](<https://math.meta.stackexchange.com/questions/5020/mathjax-basic-tutorial-and-quick-reference>).


### Use of math expressions

Put `$$` at the front and at the end of the expression to add math expressions. Like when you create [code blocks](<https://newgamedev.github.io/writing-guide-en/#code>), use line breaks to make extra space for math expressions. The added math expression will be aligned in the center.

```nil
there is a $$math expression$$ in sentence.
$$
center aligned math expression
$$
```

### Arithmetic operations

Use `+`, `-` as they are. Use the following formulas for $$\times$$, $$\div$$, $$\pm$$, $$\mp$$, $$\cdot$$.

```nil
$$\times$$, $$\div$$, $$\pm$$, $$\mp$$, $$\cdot$$
```

### Equal sign and inequality sign

Use `=` as an equal sign.

$$\lt$$, $$\gt$$, $$\leq$$, $$\geq$$, $$\neq$$, $$\simeq$$ can be expressed as below.
```nil
$$\lt$$, $$\gt$$, $$\leq$$, $$\geq$$, $$\neq$$, $$\simeq$$
```

### Square(superscript), subscript, and fraction

$$2^2=4$$, $$a_1=1$$, $$\frac{1}{2}$$ can be expressed by the following formulas.
```nil
$$2^2=4$$, $$a_1=1$$, $$\frac{1}{2}$$
```

### Matrix

A matrix begins with  `\left[\begin{matrix}`, and ends with `\end{matrix}\right]`. `\\` distinguishes lines, and `&` distinguishes the columns within the line.

$$
\left[\begin{matrix}1.6 & 1.2 \\ -1.2 & 1.6\end{matrix}\right] = \left[\begin{matrix}0.8 & 0.6 \\ -0.6 & 0.8\end{matrix}\right] \times \left[\begin{matrix}2 & 0 \\ 0 & 2\end{matrix}\right]
$$
```nil
$$
\left[\begin{matrix}1.6 & 1.2 \\ -1.2 & 1.6\end{matrix}\right] = \left[\begin{matrix}0.8 & 0.6 \\ -0.6 & 0.8\end{matrix}\right] \times \left[\begin{matrix}2 & 0 \\ 0 & 2\end{matrix}\right]
$$
```


&nbsp;
## How to use interactive code editor

newgamedev provides interactive code editor so that readers can better understand technological documents. You can naturally insert the interactive code editor in a markdown.

The main library used here is [codemirror](<https://codemirror.net/>) and [three.js](<https://threejs.org/>). I also referred to the operation of [glslEditor](<https://github.com/patriciogonzalezvivo/glslEditor>), which [Patricio Gonzalez Vivo](<https://github.com/patriciogonzalezvivo>) created for [The Book of Shaders](<https://thebookofshaders.com/>).

### How to use

Create `textarea` and surround it with `div`. Specify `codeeditor` in `class`. Make sure `tag` and the text are right next to each other in order not to make unintentional blank space.

```html
<div>
    <textarea class='codeeditor readonly'>
console.log('hello world!');</textarea>
</div>
```

<div>
    <textarea class='codeeditor readonly'>
console.log('hello world!');</textarea>
</div>

&nbsp;
### Available classes

You can set options for codemirror based on `class`. Here are the options currently provided.

* `codeeditor` : This is the default option.

* `readonly` : It shuts editors' editing.

* `fragment` : It edits fragment shader and creates canvas where you can see the result immediately.

```html
<div>
    <textarea class='codeeditor fragment'>
uniform vec2 resolution;
uniform float time;
void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec3 col = 0.5 + 0.5*cos(time+uv.xyx+vec3(0,2,4));
    gl_FragColor = vec4(vec3(col), 1.0);
}</textarea>
</div>
```

<div>
    <textarea class='codeeditor fragment'>
uniform vec2 resolution;
uniform float time;
void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec3 col = 0.5 + 0.5*cos(time+uv.xyx+vec3(0,2,4));
    gl_FragColor = vec4(vec3(col), 1.0);
}





</textarea>
</div>

&nbsp;
* `fragment-graph` : You can draw a simple graph using fragment shader. It's in the form of $$y=f(x)$$. You can use `time`, `resolution`. I referred to [The Book of Shaders](<https://thebookofshaders.com/>) for graph codes.

```html
<div>
    <textarea class='codeeditor fragment-graph'>
y = fract(sin(x+time) * 5.0);</textarea>
</div>
```

<div>
    <textarea class='codeeditor fragment-graph'>
y = fract(sin(x+time) * 5.0);</textarea>
</div>

&nbsp;

&nbsp;

&nbsp;

&nbsp;

&nbsp;
* `canvas` : You can access canvas from javascript to see the result of the operation of the code. The canvas id is `'editor_canvas_' + count.toString()`.

```html
<div>
    <textarea class='codeeditor canvas'>
let canvas = document.getElementById('editor_canvas_3');
let ctx = canvas.getContext('2d');
ctx.fillStyle = "#"+((1<<24)*Math.random()|0).toString(16);
ctx.arc(canvas.width/2, canvas.height/2, canvas.height/3, 0, Math.PI * 2);
ctx.fill();</textarea>
</div>
```

<div>
    <textarea class='codeeditor canvas'>
let canvas = document.getElementById('editor_canvas_3');
let ctx = canvas.getContext('2d');
ctx.fillStyle = "#"+((1<<24)*Math.random()|0).toString(16);
ctx.arc(canvas.width/2, canvas.height/2, canvas.height/3, 0, Math.PI * 2);
ctx.fill();</textarea>
</div>

&nbsp;
For now, only one of `fragment`, `fragment-graph`, `canvas` is required to generate a corresponding editor. The three classes cannot overlap.


&nbsp;

&nbsp;

&nbsp;

&nbsp;

&nbsp;

* `inside` : It inserts the position of `canvas` or `renderer.domElement` in the editor. inside is the default for `fragment`, `fragment-graph`.

* `outside` : It takes out the position of `canvas` or `renderer.domElement` from the editor. `outside` is the default for `canvas`.

* `fold` : You can fold the editor's code. You can specify the lines you want to fold in `data-foldlines` using `#` sign. Here the counting starts from 0, so the line number -1, which appears so in the editor, should be the standard. If you designate the lines that cannot be folded, nothing happens.

```html
<div>
    <textarea class='codeeditor fold' data-foldlines='4#11'>
let raceCount = 5;
let hexGrid = initGrid(5);
drawGrid(hexGrid);

function HexCell(x, y, z, race) {
    this._x = x;
    this._y = y;
    this._z = z;
    this._race = race;
}

function initGrid(mapSize) {
    mapSize = Math.max(1, mapSize);
    let gridArray = [];
    let cnt = 0;

    for (let i = -mapSize; i < mapSize + 1; i += 1) {
        for (let j = -mapSize; j < mapSize + 1; j += 1) {
            for (let k = -mapSize; k < mapSize + 1; k += 1) {
                if (i + j + k == 0) {
                    gridArray.push(new HexCell(i, j, k, Math.floor(Math.random() * raceCount)));
                    cnt += 1;
                }
            }
        }
    }

    return gridArray;
}</textarea>
</div>
```

<div>
    <textarea class='codeeditor fold' data-foldlines='4#11'>
let raceCount = 5;
let hexGrid = initGrid(5);
drawGrid(hexGrid);

function HexCell(x, y, z, race) {
    this._x = x;
    this._y = y;
    this._z = z;
    this._race = race;
}

function initGrid(mapSize) {
    mapSize = Math.max(1, mapSize);
    let gridArray = [];
    let cnt = 0;

    for (let i = -mapSize; i < mapSize + 1; i += 1) {
        for (let j = -mapSize; j < mapSize + 1; j += 1) {
            for (let k = -mapSize; k < mapSize + 1; k += 1) {
                if (i + j + k == 0) {
                    gridArray.push(new HexCell(i, j, k, Math.floor(Math.random() * raceCount)));
                    cnt += 1;
                }
            }
        }
    }

    return gridArray;
}</textarea>
</div>

&nbsp;
* `mark` : It marks emphasis on editor's code. In `data-marklines`, connect by `_` the `startline`, `startcolumn`, `endline`, `endcolumn` of the letters you want to emphasize. As was in `fold`, you can link several items of emphasis with `#`. Here the counting starts from 0, so the line number -1, which appears so in the editor, should be the standard. If you designate the lines that cannot be folded, nothing happens

```html
<div>
    <textarea class='codeeditor mark' data-marklines='0_4_0_12#4_27_4_30'>
let raceCount = 5;
let hexGrid = initGrid(5);
drawGrid(hexGrid);

function HexCell(x, y, z, race) {
    this._x = x;
    this._y = y;
    this._z = z;
    this._race = race;
}</textarea>
</div>
```

<div>
    <textarea class='codeeditor mark' data-marklines='0_4_0_13#4_26_4_30'>
let raceCount = 5;
let hexGrid = initGrid(5);
drawGrid(hexGrid);

function HexCell(x, y, z, race) {
    this._x = x;
    this._y = y;
    this._z = z;
    this._race = race;
}</textarea>
</div>

&nbsp;
* `hidden` : hide code editor.

```html
<div>
    <textarea class='codeeditor fragment hidden'>
uniform vec2 resolution;
uniform float time;
void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec3 col = 0.5 + 0.5*cos(time+uv.xyx+vec3(0,2,4));
    gl_FragColor = vec4(vec3(col), 1.0);
}</textarea>
</div>
```

<div>
    <textarea class='codeeditor fragment hidden'>
uniform vec2 resolution;
uniform float time;
void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec3 col = 0.5 + 0.5*cos(time+uv.xyx+vec3(0,2,4));
    gl_FragColor = vec4(vec3(col), 1.0);
}





</textarea>
</div>

&nbsp;
&nbsp;
&nbsp;
&nbsp;
&nbsp;

_End of Document_
