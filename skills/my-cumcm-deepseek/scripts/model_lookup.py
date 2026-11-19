"""Read-only, bounded lookup of a user-owned local model dictionary."""
import argparse
import json
from pathlib import Path
import sys

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--file', type=Path, required=True, help='Path to a user-provided model dictionary .xlsx')
    p.add_argument('--query', required=True)
    p.add_argument('--limit', type=int, default=3)
    args=p.parse_args()
    if not args.query.strip() or not 1 <= args.limit <= 10:
        p.error('query must be nonempty; limit must be 1..10')
    if not args.file.is_file():
        p.error('dictionary file does not exist')
    try:
        import openpyxl
    except ImportError:
        p.exit(2, 'openpyxl unavailable; lookup was not performed\n')
    wb=openpyxl.load_workbook(args.file,read_only=True,data_only=True)
    found=[]
    try:
        for ws in wb:
            it=ws.iter_rows(values_only=True)
            headers=next(it,())
            if '模型名称' not in headers:
                continue
            for row_num,row in enumerate(it,2):
                values=dict(zip(headers,row))
                searchable=' '.join(str(values.get(k) or '') for k in ['模型名称','模型大类','具体分组','模型类别','适用场景'])
                if args.query.casefold() in searchable.casefold():
                    found.append({'sheet':ws.title,'row':row_num,'fields':values})
                    if len(found)>=args.limit:
                        break
            if len(found)>=args.limit:
                break
    finally:
        wb.close()
    print(json.dumps({'source':str(args.file.resolve()),'query':args.query,'limit':args.limit,'matches':found,'note':'Bounded lookup only; entries require independent verification.'},ensure_ascii=False,indent=2,default=str))

if __name__=='__main__':
    if hasattr(sys.stdout,'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    main()
