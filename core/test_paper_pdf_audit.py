import unittest
from paper_pdf_audit import page_boundaries


class PageBoundaries(unittest.TestCase):
    def test_mama_excludes_directory_and_counts_full_body(self):
        texts = ['摘要\n关键词：灾害；回归；水文', '目录\n问题重述 1\n模型评价 29'] + ['1 问题重述'] * 29 + ['附录\n完整源程序'] * 83
        info = page_boundaries(texts, 'mathorcup-bigdata')
        self.assertEqual(info['body_pages'], 29)
        self.assertEqual(info['toc_pages'], 1)
        self.assertEqual(info['appendix_pages'], 83)

    def test_mama_contents_continuation_is_not_body(self):
        texts = ['摘要\n关键词：灾害', '目 录\n问题重述 1', '模型评价 ........ 29\n参考文献 ........ 30', '1 问题重述']
        self.assertEqual(page_boundaries(texts, 'mathorcup-bigdata')['body_pages'], 1)

    def test_mama_xelatex_split_heading(self):
        texts = ['摘要\n关键词：灾害', '目录\n模型 1', '1 问题重述', 'A\n支撑材料与软件环境\n程序']
        info = page_boundaries(texts, 'mathorcup-bigdata')
        self.assertEqual(info['body_pages'], 1)
        self.assertEqual(info['appendix_pages'], 1)

    def test_body_mention_is_not_appendix(self):
        texts = ['摘要\n关键词：调度；规划；成本'] + ['1 问题重述\n完整程序见附录。'] * 25 + ['A 支撑材料文件列表\na.py'] * 3
        self.assertEqual(page_boundaries(texts)['body_pages'], 25)
        self.assertEqual(page_boundaries(texts)['appendix_pages'], 3)

    def test_abstract_overflow_is_separate(self):
        self.assertEqual(page_boundaries(['摘要', '关键词：成本；调度；规划', '1 问题重述'])['abstract_pages'], 2)

    def test_appendix_prose_cannot_shorten_body(self):
        self.assertEqual(page_boundaries(['摘要'] + ['附录中的程序用于复现。'] * 31)['body_pages'], 31)

    def test_shared_body_appendix_page_counts_in_body(self):
        texts = ['摘要'] + ['正文'] * 30 + ['参考文献\n[1] 参考资料\n附录\n程序']
        self.assertEqual(page_boundaries(texts)['body_pages'], 31)

    def test_empty_and_one_page(self):
        self.assertEqual(page_boundaries([])['body_pages'], 0)
        self.assertEqual(page_boundaries(['摘要'])['body_pages'], 0)

    def test_unknown_contest_does_not_assume_abstract_page(self):
        info = page_boundaries(['1 问题', '2 模型', '附录\n代码'], {})
        self.assertEqual(info['abstract_pages'], 0)
        self.assertEqual(info['body_pages'], 2)

    def test_custom_package_headings_and_json_policy(self):
        policy = '{"abstract_first_page":true,"appendix_heading_titles":["计算清单"]}'
        info = page_boundaries(['首页', '目录\n问题 1', '1 问题', 'B\n计算清单\n文件'], policy)
        self.assertEqual(info['abstract_pages'], 1)
        self.assertEqual(info['toc_pages'], 1)
        self.assertEqual(info['body_pages'], 1)
        self.assertEqual(info['appendix_pages'], 1)


if __name__ == '__main__':
    unittest.main()
