"""Three v2 examples, expressed solely as data for the existing interpreter."""
from __future__ import annotations
from copy import deepcopy


def grid_game():
    lines = [(0,1,2), (3,4,5), (6,7,8), (0,3,6), (1,4,7), (2,5,8), (0,4,8), (2,4,6)]
    wins = {'or': [{'and': [{'eq': [{'cell': {'zone': 'board', 'index': i}}, {'add': [{'actor': True}, 1]}]} for i in line]} for line in lines]}
    return {
        'schemaVersion': 2, 'name': 'three-in-a-row', 'players': {'count': 2},
        'entities': {'cardRanks': [0,1]}, 'zones': [{'id': 'board', 'visibility': 'public', 'initial': [0]*9}],
        'vars': [{'id': 'score0', 'init': 0}, {'id': 'score1', 'init': 0}, {'id': 'moves', 'init': 0, 'type': 'integer'}],
        'utilities': {'type': 'zero_sum', 'min': -1, 'max': 1, 'values': [{'sub': [{'var':'score0'}, {'var':'score1'}]}, {'sub': [{'var':'score1'}, {'var':'score0'}]}]},
        'presentation': {'zones': {'board': {'kind': 'grid', 'columns': 3}}},
        'phases': [
            {'id':'play','kind':'decision','decision':{'actor':'rotate','actions':[
                {'id':'place','parameters':{'cell':list(range(9))},
                 'requires':{'expr':{'eq':[{'cell':{'zone':'board','index':{'param':'cell'}}},0]}},
                 'effects':[{'op':'setCell','zone':'board','index':{'param':'cell'},'value':{'add':[{'actor':True},1]}},
                            {'op':'incr','var':'moves','by':1},
                            {'op':'compareGoto','a':{'add':[{'mul':[2,wins]},{'eq':[{'var':'moves'},9]}]},'b':1,'gt':'win','lt':'play','eq':'end'}]}]}},
            {'id':'win','kind':'award','award':{'to':'lastActor','amount':1,'goto':'end'}},
            {'id':'end','kind':'terminal'}]}


def resource_game():
    return {'schemaVersion':2,'name':'shared-harvest','players':{'count':2},
        'entities':{'cardRanks':[0,1]}, 'zones':[{'id':'supply','visibility':'public'}],
        'vars':[{'id':'score0','init':0},{'id':'score1','init':0},{'id':'harvest','init':0,'type':'integer'}],
        'utilities':{'type':'cooperative','min':0,'max':3},
        'phases':[
            {'id':'weather','kind':'chance','chance':{'outcomes':[
                {'id':0,'weight':1,'effects':[{'op':'set','var':'harvest','value':1}]},
                {'id':1,'weight':3,'effects':[{'op':'set','var':'harvest','value':3}]}]}},
            {'id':'choose','kind':'decision','decision':{'actor':0,'actions':[
                {'id':'share','effects':[{'op':'set','var':'score0','value':{'var':'harvest'}},{'op':'set','var':'score1','value':{'var':'harvest'}}],'goto':'end'},
                {'id':'leave','goto':'end'}]}},
            {'id':'end','kind':'terminal'}]}


def commitment_game():
    # Sequential sealed decisions; the second player observes commitment,
    # never the value. This is deliberately not labelled simultaneous.
    return {'schemaVersion':2,'name':'sealed-signals','players':{'count':2},
        'entities':{'cardRanks':[0,1]},
        'zones':[{'id':'bid','perPlayer':True,'visibility':'owner'}],
        'vars':[{'id':'score0','init':0,'visibility':'hidden'},{'id':'score1','init':0,'visibility':'hidden'},
                {'id':'bid0','init':0,'visibility':'owner','owner':0}, {'id':'bid1','init':0,'visibility':'owner','owner':1}],
        'utilities':{'type':'general_sum','min':0,'max':1},
        'phases':[
            {'id':'first','kind':'decision','decision':{'actor':0,'actions':[
                {'id':'commit','visibility':'owner','parameters':{'value':[0,1]},'effects':[{'op':'set','var':'bid0','value':{'param':'value'}}]}]}},
            {'id':'second','kind':'decision','decision':{'actor':1,'actions':[
                {'id':'commit','visibility':'owner','parameters':{'value':[0,1]},'effects':[{'op':'set','var':'bid1','value':{'param':'value'}},
                    {'op':'set','var':'score0','value':{'eq':[{'var':'bid0'},{'var':'bid1'}]}},
                    {'op':'set','var':'score1','value':{'eq':[{'var':'bid0'},{'var':'bid1'}]}}]}]}},
            {'id':'end','kind':'terminal'}]}
