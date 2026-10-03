import { normalizeTopicKey } from '../data/topicCatalog.js';

const isStructuredTopicLabel = (value) => {
  const parts = String(value ?? '').split('|').map((part) => part.trim());
  return parts.length === 2 && parts.every((part) => part && part.split(/\s+/).length <= 3 && !/[.!?;,:]/.test(part)) && String(value).length <= 180;
};

export const buildTopicResolverRows = (records = [], savedMappings = [], catalogTopics = []) => {
  const canonicalByKey = new Map(catalogTopics.map((topic) => [normalizeTopicKey(topic), topic]));
  const grouped = new Map();
  const savedBySource = new Map(savedMappings.map((mapping) => [
    [mapping.subject, mapping.grade, normalizeTopicKey(mapping.sourceTopic)].join('::'),
    mapping,
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
      const catalogMatch = canonicalByKey.get(normalizeTopicKey(row.sourceTopic));
      const savedMapping = savedBySource.get(row.id);
      const savedTopic = savedMapping?.canonicalTopic;
      const savedIsCurrent = savedTopic && canonicalByKey.has(normalizeTopicKey(savedTopic));
      const savedIsSuggestion = !savedIsCurrent && savedMapping?.resolutionType === 'suggested' && isStructuredTopicLabel(savedTopic);
      return {
        ...row,
        sources: [...row.sources].sort(),
        suggestedTopic: savedIsCurrent ? canonicalByKey.get(normalizeTopicKey(savedTopic)) : catalogMatch ?? (savedIsSuggestion ? savedTopic : ''),
        matchType: savedIsCurrent ? 'saved' : catalogMatch ? 'catalog' : (savedIsSuggestion ? 'saved-suggestion' : 'unmapped'),
        isSaved: Boolean(savedIsCurrent || (!catalogMatch && savedIsSuggestion)),
      };
    })
    .sort((left, right) => left.subject.localeCompare(right.subject)
      || left.grade.localeCompare(right.grade)
      || left.sourceTopic.localeCompare(right.sourceTopic));
};
