---
layout: page
title: Publications
title2: Publications
permalink: /publications/
h_color: var(--gray0)
subtitle: "#NDC #Conference #Lecture #Graphics"
page-type: main_page
---

<script src="{{ site.baseurl | prepend: site.url }}/assets/js/publications.js"></script>

<div class="home">
    <div class="blog-page">
        <div class="item-filter">
          <div class="item-filter-title">
            FILTERS
          </div>

          <div class="blog-filter-big">
            <input type="checkbox" id="type" checked/><label for="type"></label><span class="blog-filter-big-title">Type</span><span id="type_chevron" class="chevron"></span>
          </div>
          <div id="type_subtech">
            <div class="blog-filter-small"><input type="checkbox" id="ndc" checked/><label for="ndc"></label><span class="blog-filter-small-title">NDC</span></div>
            <div class="blog-filter-small"><input type="checkbox" id="conference" checked/><label for="conference"></label><span class="blog-filter-small-title">Conference</span></div>
            <div class="blog-filter-small"><input type="checkbox" id="lecture" checked/><label for="lecture"></label><span class="blog-filter-small-title">Lecture</span></div>
          </div>

          <div class="blog-filter-big">
            <input type="checkbox" id="topic" checked/><label for="topic"></label><span class="blog-filter-big-title">Topic</span><span id="topic_chevron" class="chevron"></span>
          </div>
          <div id="topic_subtech">
            <div class="blog-filter-small"><input type="checkbox" id="gamedev" checked/><label for="gamedev"></label><span class="blog-filter-small-title">Game Dev</span></div>
            <div class="blog-filter-small"><input type="checkbox" id="graphics" checked/><label for="graphics"></label><span class="blog-filter-small-title">Graphics</span></div>
            <div class="blog-filter-small"><input type="checkbox" id="engine" checked/><label for="engine"></label><span class="blog-filter-small-title">Engine</span></div>
            <div class="blog-filter-small"><input type="checkbox" id="rendering" checked/><label for="rendering"></label><span class="blog-filter-small-title">Rendering</span></div>
          </div>
        </div>

        <div class="publication-group">
            {% assign pubs = site.data.publications | sort: "year" %}
            {% for pub in pubs reversed %}
                <div class='publication_div {% if pub.tags.size > 0 %}{% for tag in pub.tags %}{{ tag | downcase }} {% endfor %}{% endif %}'>
                    <a href='' class='show-message' data-id='{{ pub.id }}'>
                        <h3 class='pub_title'>
                            {{ pub.title }}
                        </h3>
                        <div class='publications_meta'>{{ pub.conf }}</div>
                        <div class='publications_author'>{{ pub.authors }}</div>
                        <div class="publications_tag_list">
                        {% if pub.tags.size > 0 %}
                            {% for tag in pub.tags %}
                                <a class='publication_tag' href='' data-filter="{{ tag | downcase }}">{{ tag }}</a>
                            {% endfor %}
                        {% endif %}
                        </div>
                    </a>
                    <div class="modal-hide" id="pub_popup_{{ pub.id }}" style="display:none;">{{ pub.abstract }}</div>
                </div>
            {% endfor %}
        </div>
    </div>
</div>
