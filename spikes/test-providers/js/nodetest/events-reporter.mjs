export default async function* (source) {
  for await (const e of source) {
    if (['test:enqueue','test:pass','test:fail','test:dequeue'].includes(e.type)) {
      const d = e.data; yield `${e.type} nesting=${d.nesting} type=${d.details?.type ?? ''} name=${JSON.stringify(d.name)} skip=${d.skip ?? ''} err=${d.details?.error?.cause?.message ?? d.details?.error?.message ?? ''}\n`;
    }
  }
}
