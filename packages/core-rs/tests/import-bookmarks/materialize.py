import json

BOM = b'\xef\xbb\xbf'


def link_text(index):
    return f'{{"type":"url","name":"L{index}","url":"https://example.com/{index}"}}'


def nested_folders(count):
    head = '{"roots":{"bookmark_bar":{"type":"folder","children":[' + link_text(0)
    tail = ']}}}'
    for index in range(1, count + 1):
        head += f',{{"type":"folder","name":"F{index}","children":[' + link_text(index)
        tail = ']}' + tail
    return head + tail


def links(count):
    return '{"roots":{"bookmark_bar":{"type":"folder","children":[' + ','.join(map(link_text, range(count))) + ']}}}'


def materialize(spec):
    if 'json' in spec:
        data = json.dumps(spec['json'], ensure_ascii=False, separators=(',', ':')).encode()
    elif 'text' in spec:
        data = spec['text'].encode()
    elif 'hex' in spec:
        data = bytes.fromhex(spec['hex'])
    elif 'nestedFolders' in spec:
        data = nested_folders(spec['nestedFolders']).encode()
    elif 'links' in spec:
        data = links(spec['links']).encode()
    else:
        raise ValueError(f'unknown input {sorted(spec)}')
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
