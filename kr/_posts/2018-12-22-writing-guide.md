newgamedev.github.io에 포스팅 하기위한 테스트 
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
