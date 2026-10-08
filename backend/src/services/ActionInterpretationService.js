import { inputAssembler } from './InputAssembler.js';
import { FlowType } from '../domain/enums.js';
import { validateGeneratedAction } from './GeneratedInvestigationRuntime.js';
export async function interpretAction(session, input, provider, onDebug = () => {}) {
  try {
    const result = await provider.generate(inputAssembler.assemble(FlowType.ACTION_INTERPRET, session, { userText: input }));
    const proposal = JSON.parse(result.content);
    if (!proposal || Object.keys(proposal).sort().join(',') !== 'componentId,kind,targetId'
      || ![proposal.kind,proposal.targetId,proposal.componentId].every(v => typeof v === 'string')) return null;
    proposal.ids = proposal.targetId.startsWith('evidence_') ? [proposal.targetId] : [];
    proposal.text = input;
    const checked = validateGeneratedAction(session, input, proposal);
    onDebug({ type: 'action_interpretation', flowType: FlowType.ACTION_INTERPRET, content: JSON.stringify({ proposal, accepted: checked.ok }) });
    return checked.ok ? proposal : null;
  } catch (error) {
    onDebug({ type: 'action_interpretation_failed', flowType: FlowType.ACTION_INTERPRET, content: error.message });
    return null;
  }
}
