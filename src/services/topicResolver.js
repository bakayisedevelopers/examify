import { getTopicCatalog, normalizeTopicKey, resolveTopic } from '../data/topicCatalog.js';

export const buildTopicResolverRows = (records = [], savedMappings = []) => {
  const grouped = new Map();
  const savedBySource = new Map(savedMappings.map((mapping) => [
    [mapping.subject, mapping.grade, normalizeTopicKey(mapping.sourceTopic)].join('::'),
    mapping.canonicalTopic,
  ]));
  records.forEach((record) => {
    const subject = String(record.subject || '').trim();
    const grade = String(record.grade || '').trim();
    const sourceTopic = String(record.topic || '').trim();
    if (!subject || !sourceTopic) return;
    const key = [subject, grade, normalizeTopicKey(sourceTopic)].join('::');
    const row = grouped.get(key) ?? {
      id: key,
      subject,
      grade,
      sourceTopic,
      occurrenceCount: 0,
      sources: new Set(),
      sourceExamples: [],
    };
    row.occurrenceCount += 1;
    if (record.sourceType) row.sources.add(record.sourceType);
    if (record.sourceLabel && row.sourceExamples.length < 3 && !row.sourceExamples.includes(record.sourceLabel)) {
      row.sourceExamples.push(record.sourceLabel);
    }
    grouped.set(key, row);
  });

  return [...grouped.values()]
    .map((row) => {
      const suggestion = resolveTopic({ topic: row.sourceTopic, subject: row.subject, grade: row.grade });
      const savedTopic = savedBySource.get(row.id);
      const savedIsCurrent = savedTopic && getTopicCatalog({ subject: row.subject, grade: row.grade })
        .some((topic) => topic.canonicalLabel === savedTopic);
      return {
        ...row,
        sources: [...row.sources].sort(),
        suggestedTopic: savedIsCurrent ? savedTopic : suggestion?.canonicalLabel ?? '',
        matchType: savedIsCurrent ? 'saved' : suggestion?.matchType ?? 'unmapped',
        isSaved: Boolean(savedIsCurrent),
      };
    })
    .sort((left, right) => left.subject.localeCompare(right.subject)
      || left.grade.localeCompare(right.grade)
      || left.sourceTopic.localeCompare(right.sourceTopic));
};
