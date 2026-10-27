"""Markup/CSS contract tests; not browser layout measurements."""
from html.parser import HTMLParser
from pathlib import Path
import re
import unittest

SOURCE = (Path(__file__).resolve().parent.parent / 'cbt_anki_inbox.user.js').read_text()
MARKUP = SOURCE.split('shadow.innerHTML = `', 1)[1].split('`;', 1)[0]


class Tree(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root = {'tag': 'root', 'attrs': {}, 'children': [], 'parent': None}
        self.current = self.root
        self.nodes = []

    def handle_starttag(self, tag, attrs):
        node = {'tag': tag, 'attrs': dict(attrs), 'children': [], 'parent': self.current}
        self.current['children'].append(node)
        self.nodes.append(node)
        if tag not in ('br', 'input', 'img', 'hr', 'meta', 'link'):
            self.current = node

    def handle_endtag(self, tag):
        assert self.current['tag'] == tag, (self.current['tag'], tag)
        self.current = self.current['parent']

    def handle_data(self, data):
        self.current['children'].append(data)


TREE = Tree()
TREE.feed(MARKUP)
BY_ID = {n['attrs']['id']: n for n in TREE.nodes if 'id' in n['attrs']}


def text(node):
    return ''.join(text(n) if isinstance(n, dict) else n for n in node['children'])


def in_help(node):
    while node:
        if node['attrs'].get('id') == 'inbox-help':
            return True
        node = node['parent']
    return False


class HelpTests(unittest.TestCase):
    def test_native_help_is_closed_and_accessible(self):
        help_node = BY_ID['inbox-help']
        self.assertEqual(help_node['tag'], 'details')
        self.assertNotIn('open', help_node['attrs'])
        children = [n for n in help_node['children'] if isinstance(n, dict)]
        self.assertEqual(children[0]['tag'], 'summary')
        self.assertEqual(text(children[0]), '使い方')
        self.assertEqual(TREE.current, TREE.root)

    def test_long_guidance_lives_only_inside_help(self):
        for phrase in ('Console', 'パネルの上下左右', 'selection / chapter_code',
                       '同じセッションを再利用', 'ダウンロード要求済み・保存未確認', '原則「手動のみ」',
                       'ドラッグ＆ドロップ', 'manual IDは重複防止'):
            self.assertIn(phrase, text(BY_ID['inbox-help']))
        blocks = [n for n in TREE.nodes if n['attrs'].get('class') in ('help', 'backup-help')]
        self.assertEqual(len(blocks), 2)
        self.assertTrue(all(in_help(n) for n in blocks))

    def test_export_guidance_matches_unconfirmed_save_and_session_reuse(self):
        guidance = text(BY_ID['inbox-help'])
        self.assertIn('保存成功や演習完了とは扱わず、同じchapter_codeの未完了演習は再利用します。', guidance)
        self.assertNotIn('その演習を完了扱いにします', guidance)
        self.assertNotIn('次回同じ科目を始めた時は新しいセッションになります', guidance)

    def test_actions_and_current_status_remain_outside_help(self):
        for node in TREE.nodes:
            if node['tag'] in ('button', 'input', 'textarea', 'select'):
                self.assertFalse(in_help(node), node['attrs'])
        for key in ('previous-export-warning', 'candidate-count', 'unexported-count',
                    'exercise-box', 'save-destination', 'auto-subject-status',
                    'current-candidate-list', 'exercise-history', 'copy-qb-exporter'):
            self.assertFalse(in_help(BY_ID[key]), key)
        self.assertEqual(len(BY_ID), sum('id' in n['attrs'] for n in TREE.nodes))

    def test_help_wraps_within_existing_panel_constraint(self):
        css = re.search(r'#inbox-help\s*\{([^}]+)\}', MARKUP)[1]
        for rule in ('min-width: 0;', 'max-width: 100%;', 'white-space: normal;',
                     'overflow-wrap: anywhere;'):
            self.assertIn(rule, css)
        self.assertIn('contain: inline-size', MARKUP)
        # No fixed width, geometry mutation, or toggle handler is introduced for help.
        self.assertNotRegex(css, r'(?<![-\w])width\s*:')
        self.assertEqual(SOURCE.count('inbox-help'), 3)


if __name__ == '__main__':
    unittest.main()
