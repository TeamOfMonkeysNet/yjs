/* global Y */
'use strict'

/*
  Partial definition of a transaction

  A transaction provides all the the async functionality on a database.

  By convention, a transaction has the following properties:
  * ss for StateSet
  * os for OperationStore
  * ds for DeleteStore

  A transaction must also define the following methods:
  * checkDeleteStoreForState(state)
    - When increasing the state of a user, an operation with an higher id
      may already be garbage collected, and therefore it will never be received.
      update the state to reflect this knowledge. This won't call a method to save the state!
  * getDeleteSet(id)
    - Get the delete set in a readable format:
      {
        "userX": [
          [5,1], // starting from position 5, one operations is deleted
          [9,4]  // starting from position 9, four operations are deleted
        ],
        "userY": ...
      }
  * isDeleted(id)
  * getOpsFromDeleteSet(ds) -- TODO: just call this.deleteOperation(id) here
    - get a set of deletions that need to be applied in order to get to
      achieve the state of the supplied ds
  * setOperation(op)
    - write `op` to the database.
      Note: this is allowed to return an in-memory object.
      E.g. the Memory adapter returns the object that it has in-memory.
      Changing values on this object will be stored directly in the database
      without calling this function. Therefore,
      setOperation may have no functionality in some adapters. This also has
      implications on the way we use operations that were served from the database.
      We try not to call copyObject, if not necessary.
  * addOperation(op)
    - add an operation to the database.
      This may only be called once for every op.id
      Must return a function that returns the next operation in the database (ordered by id)
  * getOperation(id)
  * removeOperation(id)
    - remove an operation from the database. This is called when an operation
      is garbage collected.
  * setState(state)
    - `state` is of the form
      {
        user: "1",
        clock: 4
      } <- meaning that we have four operations from user "1"
           (with these id's respectively: 0, 1, 2, and 3)
  * getState(user)
  * getStateVector()
    - Get the state of the OS in the form
    [{
      user: "userX",
      clock: 11
    },
     ..
    ]
  * getStateSet()
    - Get the state of the OS in the form
    {
      "userX": 11,
      "userY": 22
    }
   * getOperations(startSS)
     - Get the all the operations that are necessary in order to achive the
       stateSet of this user, starting from a stateSet supplied by another user
   * makeOperationReady(ss, op)
     - this is called only by `getOperations(startSS)`. It makes an operation
       applyable on a given SS.
*/
class AbstractTransaction {
  constructor (store) {
    this.store = store
  }
  /*
    Get a type based on the id of its model.
    If it does not exist yes, create it.
    TODO: delete type from store.initializedTypes[id] when corresponding id was deleted!
  */
  * getType (id) {
    var sid = JSON.stringify(id)
    var t = this.store.initializedTypes[sid]
    if (t == null) {
      var op = yield* this.getOperation(id)
      if (op != null) {
        t = yield* Y[op.type].initType.call(this, this.store, op)
        this.store.initializedTypes[sid] = t
      }
    }
    return t
  }
  /*
    Apply operations that this user created (no remote ones!)
      * does not check for Struct.*.requiredOps()
      * also broadcasts it through the connector
  */
  * applyCreatedOperations (ops) {
    var send = []
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i]
      yield* this.store.tryExecute.call(this, op)
      send.push(Y.Struct[op.struct].encode(op))
    }
    if (!this.store.y.connector.isDisconnected()) {
      this.store.y.connector.broadcast({
        type: 'update',
        ops: send
      })
    }
  }

  * deleteList (start) {
    if (this.store.y.connector.isSynced) {
      while (start != null && this.store.y.connector.isSynced) {
        start = (yield* this.getOperation(start))
        start.gc = true
        yield* this.setOperation(start)
        // TODO: will always reset the parent..
        this.store.gc1.push(start.id)
        start = start.right
      }
    } else {
      // TODO: when not possible??? do later in (gcWhenSynced)
    }
  }

  /*
    Mark an operation as deleted, and add it to the GC, if possible.
  */
  * deleteOperation (targetId, preventCallType) {
    var target = yield* this.getOperation(targetId)

    if (target == null || !target.deleted) {
      this.ds.markDeleted(targetId)
    }

    if (target != null && target.gc == null) {
      if (!target.deleted) {
        // set deleted & notify type
        target.deleted = true
        if (!preventCallType) {
          var type = this.store.initializedTypes[JSON.stringify(target.parent)]
          if (type != null) {
            yield* type._changed(this, {
              struct: 'Delete',
              target: targetId
            })
          }
        }
        // delete containing lists
        if (target.start != null) {
          // TODO: don't do it like this .. -.-
          yield* this.deleteList(target.start)
          yield* this.deleteList(target.id)
        }
        if (target.map != null) {
          for (var name in target.map) {
            yield* this.deleteList(target.map[name])
          }
          // TODO: here to..  (see above)
          yield* this.deleteList(target.id)
        }
        if (target.opContent != null) {
          yield* this.deleteOperation(target.opContent)
          target.opContent = null
        }
      }
      var left = target.left != null ? yield* this.getOperation(target.left) : null

      this.store.addToGarbageCollector(target, left)

      // set here because it was deleted and/or gc'd
      yield* this.setOperation(target)

      /*
        Check if it is possible to add right to the gc.
        Because this delete can't be responsible for left being gc'd,
        we don't have to add left to the gc..
      */
      var right = target.right != null ? yield* this.getOperation(target.right) : null
      if (
        right != null &&
        this.store.addToGarbageCollector(right, target)
      ) {
        yield* this.setOperation(right)
      }
    }
  }
  /*
    Really remove an op and all its effects.
    The complicated case here is the Insert operation:
    * reset left
    * reset right
    * reset parent.start
    * reset parent.end
    * reset origins of all right ops
  */
  * garbageCollectOperation (id) {
    // check to increase the state of the respective user
    var state = yield* this.getState(id[0])
    if (state.clock === id[1]) {
      state.clock++
      // also check if more expected operations were gc'd
      yield* this.checkDeleteStoreForState(state)
      // then set the state
      yield* this.setState(state)
    }
    this.ds.markGarbageCollected(id)

    // if op exists, then clean that mess up..
    var o = yield* this.getOperation(id)
    if (o != null) {
      /*
      if (!o.deleted) {
        yield* this.deleteOperation(id)
        o = yield* this.getOperation(id)
      }
      */

      // remove gc'd op from the left op, if it exists
      if (o.left != null) {
        var left = yield* this.getOperation(o.left)
        left.right = o.right
        yield* this.setOperation(left)
      }
      // remove gc'd op from the right op, if it exists
      // also reset origins of right ops
      if (o.right != null) {
        var right = yield* this.getOperation(o.right)
        right.left = o.left
        if (Y.utils.compareIds(right.origin, o.id)) { // rights origin is o
          // find new origin of right ops
          // origin is the first left deleted operation
          var neworigin = o.left
          while (neworigin != null) {
            var neworigin_ = yield* this.getOperation(neworigin)
            if (neworigin_.deleted) {
              break
            }
            neworigin = neworigin_.left
          }

          // reset origin of right
          right.origin = neworigin

          // reset origin of all right ops (except first right - duh!),
          // until you find origin pointer to the left of o
          var i = right.right == null ? null : yield* this.getOperation(right.right)
          var ids = [o.id, o.right]
          while (i != null && ids.some(function (id) {
            return Y.utils.compareIds(id, i.origin)
          })) {
            if (Y.utils.compareIds(i.origin, o.id)) {
              // reset origin of i
              i.origin = neworigin
              yield* this.setOperation(i)
            }
            // get next i
            i = i.right == null ? null : yield* this.getOperation(i.right)
          }
        } /* otherwise, rights origin is to the left of o,
             then there is no right op (from o), that origins in o */
        yield* this.setOperation(right)
      }

      if (o.parent != null) {
        // remove gc'd op from parent, if it exists
        var parent = yield* this.getOperation(o.parent)
        var setParent = false // whether to save parent to the os
        if (Y.utils.compareIds(parent.start, o.id)) {
          // gc'd op is the start
          setParent = true
          parent.start = o.right
        }
        if (Y.utils.compareIds(parent.end, o.id)) {
          // gc'd op is the end
          setParent = true
          parent.end = o.left
        }
        if (setParent) {
          yield* this.setOperation(parent)
        }
      }
      // finally remove it from the os
      yield* this.removeOperation(o.id)
    }
  }
}
Y.AbstractTransaction = AbstractTransaction

/*
  Partial definition of an OperationStore.
  TODO: name it Database, operation store only holds operations.

  A database definition must alse define the following methods:
  * logTable() (optional)
    - show relevant information information in a table
  * requestTransaction(makeGen)
    - request a transaction
  * destroy()
    - destroy the database
*/
class AbstractOperationStore {
  constructor (y, opts) {
    this.y = y
    // E.g. this.listenersById[id] : Array<Listener>
    this.listenersById = {}
    // Execute the next time a transaction is requested
    this.listenersByIdExecuteNow = []
    // A transaction is requested
    this.listenersByIdRequestPending = false
    /* To make things more clear, the following naming conventions:
       * ls : we put this.listenersById on ls
       * l : Array<Listener>
       * id : Id (can't use as property name)
       * sid : String (converted from id via JSON.stringify
                       so we can use it as a property name)

      Always remember to first overwrite
      a property before you iterate over it!
    */
    // TODO: Use ES7 Weak Maps. This way types that are no longer user,
    // wont be kept in memory.
    this.initializedTypes = {}
    this.whenUserIdSetListener = null

    this.gc1 = [] // first stage
    this.gc2 = [] // second stage -> after that, remove the op
    this.gcTimeout = opts.gcTimeout || 5000
    var os = this
    function garbageCollect () {
      return new Promise((resolve) => {
        os.requestTransaction(function * () {
          if (os.y.connector.isSynced) {
            for (var i in os.gc2) {
              var oid = os.gc2[i]
              yield* this.garbageCollectOperation(oid)
            }
            os.gc2 = os.gc1
            os.gc1 = []
          }
          if (os.gcTimeout > 0) {
            os.gcInterval = setTimeout(garbageCollect, os.gcTimeout)
          }
          resolve()
        })
      })
    }
    this.garbageCollect = garbageCollect
    if (this.gcTimeout > 0) {
      garbageCollect()
    }
  }
  stopGarbageCollector () {
    var self = this
    return new Promise(function (resolve) {
      self.requestTransaction(function * () {
        var ungc = self.gc1.concat(self.gc2)
        self.gc1 = []
        self.gc2 = []
        for (var i in ungc) {
          var op = yield* this.getOperation(ungc[i])
          delete op.gc
          yield* this.setOperation(op)
        }
        resolve()
      })
    })
  }
  garbageCollectAfterSync () {
    var os = this.os
    var self = this
    os.iterate(null, null, function (op) {
      if (op.deleted && op.left != null) {
        var left = os.find(op.left)
        self.addToGarbageCollector(op, left)
      }
    })
  }
  /*
    Try to add to GC.

    TODO: rename this function

    Rulez:
    * Only gc if this user is online
    * The most left element in a list must not be gc'd.
      => There is at least one element in the list

    returns true iff op was added to GC
  */
  addToGarbageCollector (op, left) {
    if (
      op.gc == null &&
      op.deleted === true &&
      this.y.connector.isSynced &&
      left != null &&
      left.deleted === true
    ) {
      op.gc = true
      this.gc1.push(op.id)
      return true
    } else {
      return false
    }
  }
  removeFromGarbageCollector (op) {
    function filter (o) {
      return !Y.utils.compareIds(o, op.id)
    }
    this.gc1 = this.gc1.filter(filter)
    this.gc2 = this.gc2.filter(filter)
    delete op.gc
  }
  destroy () {
    clearInterval(this.gcInterval)
    this.gcInterval = null
  }
  setUserId (userId) {
    this.userId = userId
    this.opClock = 0
    if (this.whenUserIdSetListener != null) {
      this.whenUserIdSetListener()
      this.whenUserIdSetListener = null
    }
  }
  whenUserIdSet (f) {
    if (this.userId != null) {
      f()
    } else {
      this.whenUserIdSetListener = f
    }
  }
  getNextOpId () {
    if (this.userId == null) {
      throw new Error('OperationStore not yet initialized!')
    }
    return [this.userId, this.opClock++]
  }
  /*
    Apply a list of operations.

    * get a transaction
    * check whether all Struct.*.requiredOps are in the OS
    * check if it is an expected op (otherwise wait for it)
    * check if was deleted, apply a delete operation after op was applied
  */
  apply (ops) {
    for (var key in ops) {
      var o = ops[key]
      var required = Y.Struct[o.struct].requiredOps(o)
      this.whenOperationsExist(required, o)
    }
  }
  /*
    op is executed as soon as every operation requested is available.
    Note that Transaction can (and should) buffer requests.
  */
  whenOperationsExist (ids, op) {
    if (ids.length > 0) {
      let listener = {
        op: op,
        missing: ids.length
      }

      for (let key in ids) {
        let id = ids[key]
        let sid = JSON.stringify(id)
        let l = this.listenersById[sid]
        if (l == null) {
          l = []
          this.listenersById[sid] = l
        }
        l.push(listener)
      }
    } else {
      this.listenersByIdExecuteNow.push({
        op: op
      })
    }

    if (this.listenersByIdRequestPending) {
      return
    }

    this.listenersByIdRequestPending = true
    var store = this

    this.requestTransaction(function * () {
      var exeNow = store.listenersByIdExecuteNow
      store.listenersByIdExecuteNow = []

      var ls = store.listenersById
      store.listenersById = {}

      store.listenersByIdRequestPending = false

      for (let key in exeNow) {
        let o = exeNow[key].op
        yield* store.tryExecute.call(this, o)
      }

      for (var sid in ls) {
        var l = ls[sid]
        var id = JSON.parse(sid)
        if ((yield* this.getOperation(id)) == null) {
          store.listenersById[sid] = l
        } else {
          for (let key in l) {
            let listener = l[key]
            let o = listener.op
            if (--listener.missing === 0) {
              yield* store.tryExecute.call(this, o)
            }
          }
        }
      }
    })
  }
  /*
    Actually execute an operation, when all expected operations are available.
  */
  * tryExecute (op) {
    if (op.struct === 'Delete') {
      yield* Y.Struct.Delete.execute.call(this, op)
    } else if ((yield* this.getOperation(op.id)) == null && !this.store.ds.isGarbageCollected(op.id)) {
      yield* Y.Struct[op.struct].execute.call(this, op)
      var next = yield* this.addOperation(op)
      yield* this.store.operationAdded(this, op, next)

      // Delete if DS says this is actually deleted
      if (this.store.ds.isDeleted(op.id)) {
        yield* Y.Struct['Delete'].execute.call(this, {struct: 'Delete', target: op.id})
      }
    }
  }
  // called by a transaction when an operation is added
  * operationAdded (transaction, op, next) {
    // increase SS
    var o = op
    var state = yield* transaction.getState(op.id[0])
    while (o != null && o.id[1] === state.clock && op.id[0] === o.id[0]) {
      // either its a new operation (1. case), or it is an operation that was deleted, but is not yet in the OS
      state.clock++
      yield* transaction.checkDeleteStoreForState(state)
      o = next()
    }
    yield* transaction.setState(state)

    // notify whenOperation listeners (by id)
    var sid = JSON.stringify(op.id)
    var l = this.listenersById[sid]
    delete this.listenersById[sid]

    if (l != null) {
      for (var key in l) {
        var listener = l[key]
        if (--listener.missing === 0) {
          this.whenOperationsExist([], listener.op)
        }
      }
    }
    // notify parent, if it has been initialized as a custom type
    var t = this.initializedTypes[JSON.stringify(op.parent)]
    if (t != null && !op.deleted) {
      yield* t._changed(transaction, Y.utils.copyObject(op))
    }
  }
}
Y.AbstractOperationStore = AbstractOperationStore