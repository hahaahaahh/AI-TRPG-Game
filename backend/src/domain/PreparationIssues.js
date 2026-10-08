// Bounded, data-only diagnostics. These belong in checkpoints/GM views, never player prose.
export const issue = (category, path, rejected, expected, guidance) => ({
  category, path, rejected: rejected === undefined ? null : rejected, expected, guidance,
});
export class PreparationValidationError extends Error {
  constructor(issues) {
    const bounded = issues.slice(0, 20);
    super(bounded.map(i => `${i.path}: ${i.expected}；${i.guidance}`).join('\n'));
    this.issues = bounded;
  }
}
export function shapeIssues(value, schema, path = '$') {
  const errors = [];
  const add = (p, v, expected) => errors.push(issue('schema_reference', p, v, expected, '仅修复此字段，保留已批准内容。'));
  function visit(v, s, p) {
    if (errors.length >= 20) return;
    if (s.anyOf) {
      const alternatives = s.anyOf.map(branch => shapeIssues(v, branch, p));
      if (alternatives.some(a => !a.length)) return;
      // Prefer the matching discriminator, otherwise the nearest structural variant.
      const ranked=s.anyOf.map((branch,index)=>({index,matches:Object.entries(branch.properties || {}).filter(([k,q])=>q.enum?.includes(v?.[k])).length}));
      ranked.sort((a,b)=>b.matches-a.matches || alternatives[a.index].length-alternatives[b.index].length);
      errors.push(...alternatives[ranked[0].index]);
      return;
    }
    if (s.type === 'null') { if (v !== null) add(p,v,'必须为null'); return; }
    if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { add(p,v,'需要对象'); return; }
      for (const k of Object.keys(v)) if (!Object.hasOwn(s.properties,k)) add(`${p}.${k}`,v[k],'存在额外字段；请删除');
      for (const [k,q] of Object.entries(s.properties)) visit(v[k],q,`${p}.${k}`);
    } else if (s.type === 'array') {
      if (!Array.isArray(v) || v.length > 40) { add(p,v,'需要长度不超过40的数组'); return; }
      v.forEach((item,i) => visit(item,s.items,`${p}[${i}]`));
    } else if (s.type === 'integer') {
      if (!Number.isInteger(v) || v < (s.minimum ?? 0)) add(p,v,'需要有效非负整数索引');
    } else if (typeof v !== s.type || typeof v === 'string' && v.length > 4000) add(p,v,`需要${s.type}，字符串不超过4000字`);
    if (s.enum && !s.enum.includes(v)) add(p,v,`必须选择允许的引用或枚举：${JSON.stringify(s.enum)}`);
  }
  visit(value,schema,path);
  return errors.slice(0,20);
}
export function issueFingerprint(issues) {
  // Values and prose may change while the same constraint remains unsatisfied.
  return JSON.stringify(issues.map(({category,path,expected}) => [category,path,expected]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
