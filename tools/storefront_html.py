"""Server-rendered enhancements for the existing HTML, shared with browsers and crawlers."""
import html
import json
import re
import urllib.parse


def safe_json(value):
    return json.dumps(value, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')


def set_text(source, element_id, value):
    pattern = rf'(<(?P<tag>\w+)\b[^>]*\bid="{re.escape(element_id)}"[^>]*>).*?(</(?P=tag)>)'
    return re.sub(pattern, lambda m: m[1] + html.escape(str(value or '')) + m[3], source, count=1, flags=re.S)


def metadata(source, title, description, canonical, index=True, image=None, schema=None):
    source = re.sub(r'<title\b[^>]*>.*?</title>', '<title>'+html.escape(title)+'</title>', source, count=1, flags=re.S)
    for key,value in [('description',description),('robots','index,follow' if index else 'noindex,follow')]:
        pattern=rf'<meta\s+name="{key}"[^>]*>'
        tag=f'<meta name="{key}" content="{html.escape(value,quote=True)}">'
        source=re.sub(pattern,tag,source,count=1) if re.search(pattern,source) else source.replace('</head>',tag+'\n</head>',1)
    canonical_tag=f'<link rel="canonical" href="{html.escape(canonical,quote=True)}">'
    canonical_pattern=r'<link\s+rel="canonical"[^>]*>'
    source=(re.sub(canonical_pattern,canonical_tag,source,count=1)
            if re.search(canonical_pattern,source)
            else source.replace('</head>',canonical_tag+'\n</head>',1))
    for prop,val in [('og:title',title),('og:description',description),('og:url',canonical),('og:image',image)]:
        if val:source=re.sub(rf'<meta\s+property="{prop}"[^>]*>',f'<meta property="{prop}" content="{html.escape(val,quote=True)}">',source,count=1)
    if schema:
        source=source.replace('</head>','<script id="product-jsonld" type="application/ld+json">'+safe_json(schema)+'</script>\n</head>',1)
    return source


def product_page(template, product, seo):
    source=metadata(template,seo['title'],seo['meta_description'],seo['canonical_url'],image=product.get('image_url'),schema=seo['structured_data'])
    for element,value in [('p-title',product['name_ar']),('p-name-en',product.get('name_en')),('p-price',product['price_label']),('p-short-desc',product.get('short_description_ar')),('p-oem',product.get('oem_number') or 'غير موثق'),('p-number-label',product['part_number_label'])]:
        source=set_text(source,element,value)
    # Existing gallery is populated immediately; the same API data progressively enhances it.
    if product.get('image_url'):
        source=re.sub(r'(<img\b[^>]*\bid="p-img"[^>]*>)',lambda m: re.sub(r'\bsrc="[^"]*"', 'src="'+html.escape(product['image_url'],quote=True)+'"',m[0]),source,count=1)
    if product.get('image_url'):
        preload='<link rel="preload" as="image" href="'+html.escape(product['image_url'],quote=True)+'" fetchpriority="high">'
        source=source.replace('</head>',preload+'\n</head>',1)
    source=source.replace('id="product-details" style="display:none;"','id="product-details" style="display:block;"')
    # No-JavaScript visitors also get truthful product details and navigation.
    panel='<noscript><section class="container product-section-card"><h2>'+html.escape(product['name_ar'])+'</h2><p>'+html.escape(product['description'] or '')+'</p><p>'+html.escape(product['price_label'])+' — '+html.escape(product['availability_label'])+'</p><a class="btn btn-primary" href="contact.html">استفسر عن هذه القطعة</a></section></noscript>'
    bootstrap='<script id="storefront-product-data" type="application/json">'+safe_json({'data':product,'seo':seo})+'</script>'
    return source.replace('</body>',panel+bootstrap+'\n</body>',1)


def _page_href(path_for_page, page):
    if callable(path_for_page):
        return path_for_page(page)
    if page <= 1:
        return path_for_page
    joiner = '&' if '?' in path_for_page else '?'
    return f'{path_for_page}{joiner}page={page}'


def _pagination_window(current, last, window=2):
    pages = {1, last, current}
    for i in range(current - window, current + window + 1):
        if 1 <= i <= last:
            pages.add(i)
    return sorted(pages)


def crawlable_pagination(path_for_page, current, last):
    if last <= 1:
        return ''
    current = max(1, int(current or 1))
    last = max(1, int(last or 1))
    chunks = ['<nav class="pagination-bar" id="pagination-bar" aria-label="صفحات الكتالوج">']
    if current > 1:
        chunks.append(
            f'<a class="pagination-link" href="{html.escape(_page_href(path_for_page, current - 1), quote=True)}" rel="prev" aria-label="السابق">‹</a>'
        )
    prev = 0
    for page in _pagination_window(current, last):
        if prev and page - prev > 1:
            chunks.append('<span class="pagination-ellipsis" aria-hidden="true">…</span>')
        href = html.escape(_page_href(path_for_page, page), quote=True)
        active = ' active' if page == current else ''
        current_attr = ' aria-current="page"' if page == current else ''
        chunks.append(f'<a class="pagination-link{active}" href="{href}"{current_attr}>{page}</a>')
        prev = page
    if current < last:
        chunks.append(
            f'<a class="pagination-link" href="{html.escape(_page_href(path_for_page, current + 1), quote=True)}" rel="next" aria-label="التالي">›</a>'
        )
    chunks.append('</nav>')
    return ''.join(chunks)


def collection_schema(base, title, description, canonical, products, total, breadcrumbs):
    items = []
    for index, product in enumerate(products, start=1):
        items.append({
            '@type': 'ListItem',
            'position': index,
            'url': f"{base}/product.html?id={product['id']}",
            'name': product.get('name_ar') or product.get('name_en') or f"قطعة {product['id']}",
        })
    graph = [
        {
            '@type': 'CollectionPage',
            '@id': canonical + '#page',
            'name': title,
            'description': description,
            'url': canonical,
            'isPartOf': {'@type': 'WebSite', 'name': 'CHINA PARTS', 'url': base + '/'},
            'mainEntity': {
                '@type': 'ItemList',
                'numberOfItems': int(total or 0),
                'itemListElement': items,
            },
        },
        {
            '@type': 'BreadcrumbList',
            'itemListElement': [
                {
                    '@type': 'ListItem',
                    'position': index,
                    'name': crumb['name'],
                    'item': crumb['item'],
                }
                for index, crumb in enumerate(breadcrumbs, start=1)
            ],
        },
    ]
    return {'@context': 'https://schema.org', '@graph': graph}


def collection_page(
    template,
    products,
    total,
    base,
    title='قطع غيار السيارات الصينية',
    canonical_path='/collection.html',
    index=True,
    description=None,
    page=1,
    last_page=1,
    path_for_page=None,
    breadcrumbs=None,
    landing=None,
):
    description = description or 'تصفح قطع غيار السيارات الصينية، وقارن رقم القطعة وتأكد من التوفر قبل الطلب.'
    canonical = base + canonical_path
    crumbs = breadcrumbs or [
        {'name': 'الرئيسية', 'item': base + '/'},
        {'name': 'الكتالوج', 'item': base + '/collection.html'},
    ]
    source = metadata(
        template,
        title if 'CHINA PARTS' in title else title + ' | CHINA PARTS',
        description,
        canonical,
        index=index,
        schema=collection_schema(base, title, description, canonical, products, total, crumbs),
    )
    cards = []
    for p in products:
        img = (
            '<img loading="lazy" decoding="async" width="320" height="320" src="'
            + html.escape(p['image_url'], quote=True)
            + '" alt="'
            + html.escape(p['name_ar'], quote=True)
            + '">'
            if p.get('image_url')
            else ''
        )
        cards.append(
            '<article class="product-card"><a class="product-card-img-wrap" href="product.html?id='
            + str(p['id'])
            + '">'
            + img
            + '</a><div class="product-card-body"><a class="product-title" href="product.html?id='
            + str(p['id'])
            + '">'
            + html.escape(p['name_ar'])
            + '</a><p>'
            + html.escape(p['price_label'])
            + '</p><small>'
            + html.escape(p['availability_label'])
            + '</small></div></article>'
        )
    source = re.sub(
        r'(<div class="products-grid" id="products-grid">).*?(</div>\s*<div class="pagination-bar")',
        lambda m: m[1] + ''.join(cards) + m[2],
        source,
        count=1,
        flags=re.S,
    )
    pager = crawlable_pagination(path_for_page or canonical_path, page, last_page)
    if pager:
        source = re.sub(
            r'<div class="pagination-bar" id="pagination-bar"></div>',
            pager,
            source,
            count=1,
        )
    source = set_text(source, 'page-title', title)
    source = set_text(source, 'results-count', f'{total} قطعة')
    bootstrap = {
        'landing': landing or {'kind': 'catalog'},
        'page': int(page or 1),
        'last_page': int(last_page or 1),
        'total': int(total or 0),
        'canonical_path': canonical_path,
        'indexable': bool(index),
    }
    return source.replace(
        '</body>',
        '<script id="storefront-collection-data" type="application/json">' + safe_json(bootstrap) + '</script>\n</body>',
        1,
    )
