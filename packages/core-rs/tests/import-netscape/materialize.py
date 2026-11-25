BOM = b'\xef\xbb\xbf'
HEADER = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n'


def link_text(index):
    return f'<DT><A HREF="https://example.com/{index}" ADD_DATE="{1700000000 + index}">L{index}</A>\n'


def nested_folders(count):
    head = HEADER + '<DL><p>\n' + link_text(0)
    for index in range(1, count + 1):
        head += f'<DT><H3>F{index}</H3>\n<DL><p>\n' + link_text(index)
    return head + '</DL><p>\n' * (count + 1)


def nested_lists(count):
    return HEADER + '<DL><p>\n' * count + '<DT><A HREF="https://deep.example/">Deep</A>\n' + '</DL><p>\n' * count


def unclosed_lists(count):
    return HEADER + '<DL><p>\n' * count + '<DT><A HREF="https://deep.example/">Deep</A>\n'


def links(count, inside=0):
    opened = ''.join(f'<DT><H3>F{index}</H3>\n<DL><p>\n' for index in range(1, inside + 1))
    return HEADER + '<DL><p>\n' + opened + ''.join(map(link_text, range(count))) + '</DL><p>\n' * (inside + 1)


GENERATORS = {
    'nestedFolders': nested_folders,
    'nestedLists': nested_lists,
    'unclosedLists': unclosed_lists,
    'links': links,
}


def materialize(spec):
    if 'text' in spec:
        data = spec['text'].encode()
    elif 'hex' in spec:
        data = bytes.fromhex(spec['hex'])
    else:
        made = [name for name in GENERATORS if name in spec]
        if len(made) != 1:
            raise ValueError(f'unknown input {sorted(spec)}')
        extra = {'inside': spec['insideFolders']} if 'insideFolders' in spec else {}
        data = GENERATORS[made[0]](spec[made[0]], **extra).encode()
    data = BOM * int(spec.get('bom', 0)) + data
    if 'padTo' in spec:
        if len(data) > spec['padTo']:
            raise ValueError(f'input is already {len(data)} bytes, over padTo {spec["padTo"]}')
        data += b' ' * (spec['padTo'] - len(data))
    return data


def shape(top):
    counts = {'links': 0, 'folders': 0, 'depth': 0}
    stack = [(child, 1) for child in top.get('children') or []]
    while stack:
        node, depth = stack.pop()
        if node['type'] == 'url':
            counts['links'] += 1
            continue
        counts['folders'] += 1
        counts['depth'] = max(counts['depth'], depth)
        stack.extend((child, depth + 1) for child in node.get('children') or [])
    return counts


def same(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return float(left) == float(right)
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(same(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(same(a, b) for a, b in zip(left, right))
    return left == right
