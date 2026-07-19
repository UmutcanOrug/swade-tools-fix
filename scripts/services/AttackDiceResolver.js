function asFiniteNumber(value) {
    const number=Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeRof(value) {
    const number=Math.floor(Number(value));
    return Number.isFinite(number) && number>0 ? number : 1;
}

function selectBest(candidates,rof) {
    return candidates
        .filter(candidate=>candidate.total!==null)
        .sort((left,right)=>
            right.total-left.total || left.sourceIndex-right.sourceIndex
        )
        .slice(0,rof)
        .map(candidate=>({
            ...candidate,
            id:`attack-die-${candidate.sourceIndex}`
        }));
}

export function extractAttackDice(roll,requestedRof=1) {
    const rof=normalizeRof(requestedRof);

    if (!roll) {
        return [];
    }

    if (typeof roll._formatResultParts==='function') {
        const formatted=roll._formatResultParts()
            ?.filter(part=>part?.die)
            .map((part,sourceIndex)=>({
                sourceIndex,
                total: asFiniteNumber(part.result)
            })) ?? [];

        if (formatted.length) {
            return selectBest(formatted,rof);
        }
    }

    const pool=roll.terms?.find(term=>
        Array.isArray(term?.results) || Array.isArray(term?.rolls)
    );
    const results=Array.isArray(pool?.results)
        ? pool.results
        : (pool?.rolls ?? []).map(subroll=>({result: subroll?.total}));
    const candidates=results.map((result,sourceIndex)=>({
        sourceIndex,
        total: asFiniteNumber(result?.result ?? result?.total),
        discarded: result?.discarded===true || result?.active===false
    }));
    const active=candidates.filter(candidate=>!candidate.discarded);
    const usable=active.length ? active : candidates;

    if (usable.length) {
        return selectBest(usable,rof);
    }

    const total=asFiniteNumber(roll.total);
    return total===null
        ? []
        : [{id: 'attack-die-0',sourceIndex: 0,total}];
}
