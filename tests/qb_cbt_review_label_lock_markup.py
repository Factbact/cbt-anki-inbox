from html.parser import HTMLParser
from pathlib import Path
import re
source=(Path(__file__).resolve().parents[1]/'qb_cbt_review_label_lock.user.js').read_text()
markup=source.split('    sh.innerHTML = `',1)[1].split('`;',1)[0]
class PanelParser(HTMLParser):
 def __init__(self):
  super().__init__();self.stack=[];self.ids={}
 def handle_starttag(self,tag,attrs):
  attrs=dict(attrs)
  if 'id' in attrs:
   assert attrs['id'] not in self.ids,('duplicate',attrs['id'])
   self.ids[attrs['id']]=[(t,a.get('id')) for t,a in self.stack]
  if tag not in ['input','br','hr','img','meta','link']:self.stack.append((tag,attrs))
 def handle_endtag(self,tag):
  if tag in ['input','br','hr','img','meta','link']:return
  assert self.stack and self.stack[-1][0]==tag,('unbalanced',tag,self.stack[-2:])
  self.stack.pop()
p=PanelParser();p.feed(markup);assert not p.stack
refs=set(re.findall(r"(?:sh|ui\.shadow)\.getElementById\('([^']+)'\)",source))
assert refs<=p.ids.keys(),refs-p.ids.keys()
for key in ['mode','historyDetails','fixedSettings','otherSettings']:
 assert ('details','settingsDetails') in p.ids[key],key
for key in ['smartSettings','status','statusAction','unsure','undo']:
 assert ('details','settingsDetails') not in p.ids[key],key
assert 'open' not in markup.split('<details id="settingsDetails"',1)[1].split('>',1)[0]
print(f'PASS: balanced panel markup, {len(p.ids)} unique IDs, all {len(refs)} UI references resolved, daily controls outside settings')
