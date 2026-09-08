import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const FILE=new URL('./gsc-harvest.json', import.meta.url);
const AUDIT=new URL('./audit.json', import.meta.url);
const ENDPOINT='https://searchconsole.googleapis.com/webmasters/v3/sites/{property}/searchAnalytics/query';

function totals(properties,period,route) {
  const result={clicks:0,impressions:0};
  for (const property of properties.slice(0,200)) {
    const source=property.periods[period][route];
    if (!source || (source.rows || []).length>100) throw new Error('Unexpected row count');
    for (const row of (source.rows || []).slice(0,100)) {
      for (const key of ['clicks','impressions']) {
        if (!Number.isSafeInteger(row[key]) || row[key]<0) throw new Error('Invalid raw count');
        result[key]+=row[key];
      }
      if (row.clicks>row.impressions) throw new Error('Clicks exceed matched impressions');
    }
  }
  return result;
}

function measure(raw,route) {
  const properties=raw.properties.filter(p=>['earlier','later'].some(t=>totals([p],t,route).impressions>0));
  if (!properties.length || properties.length>200) throw new Error('Invalid cohort');
  const ranked=properties.slice().sort((a,b)=>['earlier','later'].reduce((sum,t)=>sum+totals([b],t,route).impressions-totals([a],t,route).impressions,0));
  const largest=ranked[0];
  const views={pooled:properties,largest:[largest],excluded:properties.filter(p=>p.domain!==largest.domain)};
  const values={cohort_count:properties.length,queried_count:raw.properties.length,omitted_count:raw.properties.length-properties.length};
  for (const [view,rows] of Object.entries(views)) {
    for (const period of ['earlier','later']) {
      const counts=totals(rows,period,route);
      for (const metric of ['clicks','impressions']) values[`${view}_${period}_${metric}`]=counts[metric];
      if (counts.impressions<=0) throw new Error('Undefined CTR');
      values[`${view}_${period}_ctr`]=Math.round(counts.clicks/counts.impressions*1e6)/1e4;
    }
  }
  return values;
}

export async function fields() {
  let raw;
  try {
    const bytes=await fs.readFile(FILE);
    const audit=JSON.parse(await fs.readFile(AUDIT,'utf8'));
    if (crypto.createHash('sha256').update(bytes).digest('hex')!==audit.rawSha256) throw new Error('Audit checksum mismatch');
    raw=JSON.parse(bytes.toString('utf8'));
  } catch {throw new Error('Cannot read independently audited harvest');}
  if (!Array.isArray(raw.properties) || !raw.periods || raw.properties.length>200) throw new Error('Invalid harvest shape');
  const age=Date.now()-Date.parse(raw.fetchedAt);
  if (!Number.isFinite(age) || age<0 || age>24*3600000) throw new Error('Harvest older than one day');
  const primary=measure(raw,'flat'), check=measure(raw,'daily');
  return Object.keys(primary).map(id=>({id,primary:ENDPOINT+' dimensions=[]; snapshot '+raw.fetchedAt,
    primaryFetch:async()=>primary[id],crossChecks:[async()=>check[id]],maxStaleHours:24,saneRange:[0,id.endsWith('_ctr')?100:1e12]}));
}
