export default class PowerPointService {
    static completedTransactions=new Set();
    static queues=new Map();

    static isNoPowerPoints() {
        return game.settings.get('swade','noPowerPoints')===true;
    }

    static resolveCost(item,override=null) {
        const explicit=Number(override);

        if (override!==null && override!==undefined &&
            Number.isFinite(explicit)) {
            return Math.max(0,Math.floor(explicit));
        }

        const calculated=Number(
            item?.system?.ppModifiers?.cost ??
            item?.system?.pp ??
            0
        );
        return Number.isFinite(calculated)
            ? Math.max(0,Math.floor(calculated))
            : 0;
    }

    static getResource(item) {
        if (!item) {
            return null;
        }

        if (item.isArcaneDevice) {
            return {
                document: item,
                path: 'system.powerPoints.value',
                value: Number(item.system?.powerPoints?.value ?? 0)
            };
        }

        if (item.type!=='power' || this.isNoPowerPoints()) {
            return null;
        }

        const actor=item.actor ?? item.parent;
        const arcane=item.system?.arcane || 'general';

        if (!actor) {
            return null;
        }

        return {
            document: actor,
            path: `system.powerPoints.${arcane}.value`,
            value: Number(
                foundry.utils.getProperty(
                    actor,
                    `system.powerPoints.${arcane}.value`
                ) ?? 0
            )
        };
    }

    static validate(item,costOverride=null) {
        const cost=this.resolveCost(item,costOverride);
        const resource=this.getResource(item);

        if (!resource || cost===0) {
            return {ok: true,cost,available: resource?.value ?? Infinity};
        }

        if (!Number.isFinite(resource.value) || resource.value<cost) {
            return {
                ok: false,
                cost,
                available: Number.isFinite(resource.value) ? resource.value : 0,
                reason: 'insufficient'
            };
        }

        return {ok: true,cost,available: resource.value};
    }

    static async commitActivation(
        item,
        {
            costOverride=null,
            success=true,
            transactionId=null
        }={}
    ) {
        if (transactionId && this.completedTransactions.has(transactionId)) {
            return {ok: true,consumed: 0,duplicate: true};
        }

        const resource=this.getResource(item);
        const fullCost=this.resolveCost(item,costOverride);
        const spend=success ? fullCost : Math.min(1,fullCost);

        if (!resource || spend===0) {
            if (transactionId) {
                this.completedTransactions.add(transactionId);
            }
            return {ok: true,consumed: 0};
        }

        const key=`${resource.document.uuid ?? resource.document.id}:${resource.path}`;
        const previous=this.queues.get(key) ?? Promise.resolve();
        const task=previous.catch(()=>undefined).then(async ()=>{
            if (transactionId &&
                this.completedTransactions.has(transactionId)) {
                return {ok: true,consumed: 0,duplicate: true};
            }

            const current=this.getResource(item);

            if (!current || !Number.isFinite(current.value) ||
                current.value<spend) {
                return {ok: false,consumed: 0,reason: 'insufficient'};
            }

            await current.document.update({
                [current.path]: Math.max(0,current.value-spend)
            });

            if (transactionId) {
                this.completedTransactions.add(transactionId);
            }

            return {ok: true,consumed: spend};
        });

        this.queues.set(key,task);

        try {
            return await task;
        } finally {
            if (this.queues.get(key)===task) {
                this.queues.delete(key);
            }
        }
    }
}
