/* eslint-disable no-restricted-syntax */
/* eslint-disable max-len, no-plusplus, guard-for-in */
/* eslint-disable import/no-dynamic-require, global-require */
const { Scalar } = require('ffjavascript');
const fs = require('fs');
const path = require('path');
const { ethers } = require('hardhat');
const { expect } = require('chai');
const { argv } = require('yargs');
const {
    Address, toBuffer,
} = require('ethereumjs-util');
const lodash = require('lodash');
const {
    MemDB, stateUtils, contractUtils, ZkEVMDB, processorUtils,
    getPoseidon, smtUtils, Constants,
} = require('@polygon-hermez/zkevm-commonjs');

const { calculateSnarkInput } = contractUtils;
const MerkleTreeBridge = require('@polygon-hermez/zkevm-commonjs').MTBridge;
const {
    calculateLeafValue,
} = require('@polygon-hermez/zkevm-commonjs').mtBridgeUtils;

const {
    ERC20PermitMock, GlobalExitRootManagerMock, Bridge, ProofOfEfficiencyMock, VerifierRollupHelperMock,
} = require('@polygon-hermez/contracts-zkevm');

const contractsPolygonHermez = require('@polygon-hermez/contracts-zkevm');

const { pathTestVectors } = require('../../helpers/helpers');

const pathStateTransition = path.join(pathTestVectors, './state-transition/e2e/e2e.json');
const testE2E = JSON.parse(fs.readFileSync(pathStateTransition));

async function setNextBlockTimestamp(timestamp) {
    return (ethers.provider.send('evm_setNextBlockTimestamp', [timestamp]));
}

describe('Proof of efficiency test vectors', function () {
    this.timeout(0);

    let update;
    let poseidon;
    let F;

    let deployer;
    let aggregator;

    let verifierContract;
    let bridgeContract;
    let proofOfEfficiencyContract;
    let maticTokenContract;
    let globalExitRootManager;

    const maticTokenName = 'Matic Token';
    const maticTokenSymbol = 'MATIC';
    const maticTokenInitialBalance = ethers.utils.parseEther('20000000');

    const networkIDMainnet = 0;
    const networkIDRollup = 1;

    before(async () => {
        update = argv.update === true;
    });

    beforeEach('Deploy contract', async () => {
        // build poseidon
        poseidon = await getPoseidon();
        F = poseidon.F;

        // load signers
        [deployer, aggregator] = await ethers.getSigners();

        // deploy mock verifier
        const VerifierRollupHelperFactory = new ethers.ContractFactory(VerifierRollupHelperMock.abi, VerifierRollupHelperMock.bytecode, deployer);
        verifierContract = await VerifierRollupHelperFactory.deploy();

        // deploy MATIC
        const maticTokenFactory = new ethers.ContractFactory(ERC20PermitMock.abi, ERC20PermitMock.bytecode, deployer);
        maticTokenContract = await maticTokenFactory.deploy(
            maticTokenName,
            maticTokenSymbol,
            deployer.address,
            maticTokenInitialBalance,
        );
        await maticTokenContract.deployed();
        const precalculatBridgeAddress = await ethers.utils.getContractAddress(
            { from: deployer.address, nonce: (await ethers.provider.getTransactionCount(deployer.address)) + 1 },
        );

        const precalculatePoEAddress = await ethers.utils.getContractAddress(
            { from: deployer.address, nonce: (await ethers.provider.getTransactionCount(deployer.address)) + 2 },
        );

        // deploy global exit root manager
        const globalExitRootManagerFactory = new ethers.ContractFactory(GlobalExitRootManagerMock.abi, GlobalExitRootManagerMock.bytecode, deployer);
        globalExitRootManager = await globalExitRootManagerFactory.deploy(precalculatePoEAddress, precalculatBridgeAddress);
        await globalExitRootManager.deployed();

        // deploy bridge
        const bridgeFactory = new ethers.ContractFactory(Bridge.abi, Bridge.bytecode, deployer);
        bridgeContract = await bridgeFactory.deploy(networkIDMainnet, globalExitRootManager.address);
        await bridgeContract.deployed();

        // deploy proof of efficiency
        const ProofOfEfficiencyFactory = new ethers.ContractFactory(ProofOfEfficiencyMock.abi, ProofOfEfficiencyMock.bytecode, deployer);
        proofOfEfficiencyContract = await ProofOfEfficiencyFactory.deploy(
            globalExitRootManager.address,
            maticTokenContract.address,
            verifierContract.address,
            testE2E.expectedOldRoot,
        );
        await proofOfEfficiencyContract.deployed();

        expect(bridgeContract.address).to.be.equal(precalculatBridgeAddress);
        expect(proofOfEfficiencyContract.address).to.be.equal(precalculatePoEAddress);
    });
    it('End to end test', async () => {
        const {
            genesis,
            expectedOldRoot,
            txs,
            expectedNewRoot,
            chainIdSequencer,
            sequencerAddress,
            expectedNewLeafs,
            batchL2Data,
            oldLocalExitRoot,
            newLocalExitRoot,
            globalExitRoot,
            batchHashData,
            inputHash,
            timestamp,
            bridgeDeployed,
            sequencerPvtKey,
        } = testE2E;

        /*
        * /////////////////////////////////////////////////
        * // User interact with the bridge
        * /////////////////////////////////////////////////
        */

        // Add a claim leaf to rollup exit tree
        const claimAddress = '0xC949254d682D8c9ad5682521675b8F43b102aec4';
        const originalNetwork = networkIDMainnet;
        const tokenAddress = ethers.constants.AddressZero; // ether
        const amount = ethers.utils.parseEther('10');
        const destinationNetwork = networkIDRollup;
        const destinationAddress = claimAddress;

        const depositCount = 1;
        const mainnetRoot = '0x843cb84814162b93794ad9087a037a1948f9aff051838ba3a93db0ac92b9f719';
        let lastGlobalExitRootNum = 0;

        await expect(bridgeContract.bridge(tokenAddress, amount, destinationNetwork, destinationAddress, { value: amount }))
            .to.emit(bridgeContract, 'BridgeEvent')
            .withArgs(tokenAddress, amount, originalNetwork, destinationNetwork, destinationAddress, depositCount)
            .to.emit(globalExitRootManager, 'UpdateGlobalExitRoot')
            .withArgs(++lastGlobalExitRootNum, mainnetRoot, ethers.constants.HashZero);

        /*
        * /////////////////////////////////////////////////
        * // Register sequencer
        * /////////////////////////////////////////////////
        */
        // fund sequencer address with Matic tokens and ether
        await maticTokenContract.transfer(sequencerAddress, ethers.utils.parseEther('100'));
        await deployer.sendTransaction({
            to: sequencerAddress,
            value: ethers.utils.parseEther('10.0'),
        });

        // Register a sequencer
        const walletSequencer = new ethers.Wallet(sequencerPvtKey, ethers.provider);
        const sequencerURL = 'http://exampleURL';
        const defaultChainId = Number(await proofOfEfficiencyContract.DEFAULT_CHAIN_ID());

        await expect(proofOfEfficiencyContract.connect(walletSequencer).registerSequencer(sequencerURL))
            .to.emit(proofOfEfficiencyContract, 'RegisterSequencer')
            .withArgs(sequencerAddress, sequencerURL, ethers.BigNumber.from(defaultChainId + 1));

        /*
        * /////////////////////////////////////////////////
        * // Build batch
        * /////////////////////////////////////////////////
        */

        // eslint-disable-next-line no-loop-func
        const db = new MemDB(F);
        // create a zkEVMDB to compile the sc
        const zkEVMDB = await ZkEVMDB.newZkEVM(
            db,
            poseidon,
            [F.zero, F.zero, F.zero, F.zero],
            smtUtils.stringToH4(oldLocalExitRoot),
            genesis,
            null,
            null,
        );

        // Check evm contract params
        const addressToContractInterface = {};
        for (const contract of genesis) {
            if (contract.contractName) {
                // Add contract interface for future contract interaction
                if (contractsPolygonHermez[contract.contractName]) {
                    const contractInterface = new ethers.utils.Interface(contractsPolygonHermez[contract.contractName].abi);
                    addressToContractInterface[contract.address] = contractInterface;
                } else {
                    const contractInterface = new ethers.utils.Interface(contract.abi);
                    addressToContractInterface[contract.address] = contractInterface;
                }
                const contractAddres = new Address(toBuffer(contract.address));

                const contractAccount = await zkEVMDB.vm.stateManager.getAccount(contractAddres);
                expect(await contractAccount.isContract()).to.be.equal(true);

                const contractCode = await zkEVMDB.vm.stateManager.getContractCode(contractAddres);
                expect(contractCode.toString('hex')).to.be.equal(contract.bytecode.slice(2));

                const dumpDB = await zkEVMDB.dumpStorage(contract.address);

                for (const [key, value] of Object.entries(contract.storage)) {
                    const contractStorage = await zkEVMDB.vm.stateManager.getContractStorage(contractAddres, toBuffer(key));
                    expect(contractStorage.toString('hex')).to.equal(value.slice(2));
                    expect(dumpDB[key]).to.be.equal(value);
                }
            }
        }

        if (!update) {
            expect(smtUtils.h4toString(zkEVMDB.stateRoot)).to.be.equal(expectedOldRoot);
        } else {
            testE2E.expectedOldRoot = smtUtils.h4toString(zkEVMDB.stateRoot);
        }

        /*
         * build, sign transaction and generate rawTxs
         * rawTxs would be the calldata inserted in the contract
         */
        const txProcessed = [];
        const rawTxs = [];
        for (let j = 0; j < txs.length; j++) {
            const txData = txs[j];

            const tx = {
                to: txData.to,
                nonce: txData.nonce,
                value: processorUtils.toHexStringRlp(ethers.utils.parseUnits(txData.value, 'wei')),
                gasLimit: txData.gasLimit,
                gasPrice: processorUtils.toHexStringRlp(ethers.utils.parseUnits(txData.gasPrice, 'wei')),
                chainId: txData.chainId,
                data: txData.data || '0x',
            };

            if (txData.data) {
                if (txData.to) {
                    if (txData.contractName) {
                        const functionData = addressToContractInterface[txData.to].encodeFunctionData(txData.function, txData.params);
                        if (!update) {
                            expect(functionData).to.equal(txData.data);
                        } else {
                            txData.data = functionData;
                            tx.data = functionData;
                        }
                    }
                }
            }

            if ((tx.to && tx.to !== '0x0' && !ethers.utils.isAddress(tx.to)) || !ethers.utils.isAddress(txData.from)) {
                expect(txData.customRawTx).to.equal(undefined);
                // eslint-disable-next-line no-continue
                continue;
            }

            let customRawTx;
            const address = genesis.find((o) => o.address === txData.from);
            const wallet = new ethers.Wallet(address.pvtKey);
            if (tx.chainId === 0) {
                const signData = ethers.utils.RLP.encode([
                    processorUtils.toHexStringRlp(Scalar.e(tx.nonce)),
                    processorUtils.toHexStringRlp(tx.gasPrice),
                    processorUtils.toHexStringRlp(tx.gasLimit),
                    processorUtils.toHexStringRlp(tx.to),
                    processorUtils.toHexStringRlp(tx.value),
                    processorUtils.toHexStringRlp(tx.data),
                    processorUtils.toHexStringRlp(tx.chainId),
                    '0x',
                    '0x',
                ]);
                const digest = ethers.utils.keccak256(signData);
                const signingKey = new ethers.utils.SigningKey(address.pvtKey);
                const signature = signingKey.signDigest(digest);
                const r = signature.r.slice(2).padStart(64, '0'); // 32 bytes
                const s = signature.s.slice(2).padStart(64, '0'); // 32 bytes
                const v = (signature.v).toString(16).padStart(2, '0'); // 1 bytes
                customRawTx = signData.concat(r).concat(s).concat(v);
            } else {
                const rawTxEthers = await wallet.signTransaction(tx);
                if (!update) {
                    expect(rawTxEthers).to.equal(txData.rawTx);
                } else {
                    txData.rawTx = rawTxEthers;
                }
                customRawTx = processorUtils.rawTxToCustomRawTx(rawTxEthers);
            }

            if (!update) {
                expect(customRawTx).to.equal(txData.customRawTx);
            } else {
                txData.customRawTx = customRawTx;
            }

            rawTxs.push(customRawTx);
            txProcessed.push(txData);
        }

        const batch = await zkEVMDB.buildBatch(timestamp, sequencerAddress, chainIdSequencer, smtUtils.stringToH4(globalExitRoot));
        for (let j = 0; j < rawTxs.length; j++) {
            batch.addRawTx(rawTxs[j]);
        }

        // execute the transactions added to the batch
        await batch.executeTxs();
        // consolidate state
        await zkEVMDB.consolidate(batch);

        const newRoot = batch.currentStateRoot;
        if (!update) {
            expect(smtUtils.h4toString(newRoot)).to.be.equal(expectedNewRoot);
        } else {
            testE2E.expectedNewRoot = smtUtils.h4toString(newRoot);
        }

        // Check errors on decode transactions
        const decodedTx = await batch.getDecodedTxs();

        for (let j = 0; j < decodedTx.length; j++) {
            const currentTx = decodedTx[j];
            const expectedTx = txProcessed[j];
            try {
                expect(currentTx.reason).to.be.equal(expectedTx.reason);
            } catch (error) {
                console.log({ currentTx }, { expectedTx }); // eslint-disable-line no-console
                throw new Error(`TxId:${expectedTx.id} ${error}`);
            }
        }

        // Check balances and nonces
        const updatedAccounts = batch.getUpdatedAccountsBatch();
        const newLeafs = {};
        for (const item in updatedAccounts) {
            const address = item;
            const account = updatedAccounts[address];
            newLeafs[address] = {};

            const newLeaf = await zkEVMDB.getCurrentAccountState(address);
            expect(newLeaf.balance.toString()).to.equal(account.balance.toString());
            expect(newLeaf.nonce.toString()).to.equal(account.nonce.toString());

            const smtNewLeaf = await zkEVMDB.getCurrentAccountState(address);
            expect(smtNewLeaf.balance.toString()).to.equal(account.balance.toString());
            expect(smtNewLeaf.nonce.toString()).to.equal(account.nonce.toString());

            newLeafs[address].balance = account.balance.toString();
            newLeafs[address].nonce = account.nonce.toString();

            // If account is a contract, update storage and bytecode
            if (account.isContract()) {
                // const addressInstance = Address.fromString(address);
                // const smCode = await currentVM.stateManager.getContractCode(addressInstance);
                const storage = await zkEVMDB.dumpStorage(address);

                // newLeafs[address].bytecode = `0x${smCode.toString('hex')}`;
                newLeafs[address].storage = storage;
            }
        }
        for (const leaf of genesis) {
            if (!newLeafs[leaf.address.toLowerCase()]) {
                newLeafs[leaf.address] = { ...leaf };
                delete newLeafs[leaf.address].address;
                delete newLeafs[leaf.address].bytecode;
                delete newLeafs[leaf.address].contractName;
            }
        }

        if (!update) {
            for (const [address, leaf] of Object.entries(expectedNewLeafs)) {
                expect(lodash.isEqual(leaf, newLeafs[address])).to.be.equal(true);
            }
        } else {
            testE2E.expectedNewLeafs = newLeafs;
        }

        // Check global and local exit roots
        const addressInstanceGlobalExitRoot = new Address(toBuffer(Constants.ADDRESS_GLOBAL_EXIT_ROOT_MANAGER_L2));
        const localExitRootPosBuffer = toBuffer(ethers.utils.hexZeroPad(Constants.LOCAL_EXIT_ROOT_STORAGE_POS, 32));
        const globalExitRootPos = ethers.utils.solidityKeccak256(['uint256', 'uint256'], [batch.batchNumber, Constants.GLOBAL_EXIT_ROOT_STORAGE_POS]);
        const globalExitRootPosBuffer = toBuffer(globalExitRootPos);

        // Check local exit root
        const localExitRootVm = await zkEVMDB.vm.stateManager.getContractStorage(addressInstanceGlobalExitRoot, localExitRootPosBuffer);
        const localExitRootSmt = (await stateUtils.getContractStorage(
            Constants.ADDRESS_GLOBAL_EXIT_ROOT_MANAGER_L2,
            zkEVMDB.smt,
            zkEVMDB.stateRoot,
            [Constants.LOCAL_EXIT_ROOT_STORAGE_POS],
        ))[Constants.LOCAL_EXIT_ROOT_STORAGE_POS];

        if (localExitRootSmt === Scalar.e(0)) {
            expect(localExitRootVm.toString('hex')).to.equal('');
            expect(newLocalExitRoot).to.equal(ethers.constants.HashZero);
        } else {
            expect(localExitRootVm.toString('hex')).to.equal(localExitRootSmt.toString(16).padStart(64, '0'));
            expect(localExitRootVm.toString('hex')).to.equal(newLocalExitRoot.slice(2));
        }

        // Check global exit root
        const globalExitRootVm = await zkEVMDB.vm.stateManager.getContractStorage(
            addressInstanceGlobalExitRoot,
            globalExitRootPosBuffer,
        );
        const globalExitRootSmt = (await stateUtils.getContractStorage(
            Constants.ADDRESS_GLOBAL_EXIT_ROOT_MANAGER_L2,
            zkEVMDB.smt,
            zkEVMDB.stateRoot,
            [globalExitRootPos],
        ))[Scalar.e(globalExitRootPos)];

        if (globalExitRootSmt === Scalar.e(0)) {
            expect(globalExitRootVm.toString('hex')).to.equal('');
            expect(globalExitRoot).to.equal(ethers.constants.HashZero);
        } else {
            expect(globalExitRootVm.toString('hex')).to.equal(globalExitRootSmt.toString(16).padStart(64, '0'));
            expect(globalExitRootVm.toString('hex')).to.equal(globalExitRoot.slice(2));
        }

        // Check through a call in the EVM
        if (bridgeDeployed) {
            const interfaceGlobal = new ethers.utils.Interface(['function globalExitRootMap(uint256)']);
            const encodedData = interfaceGlobal.encodeFunctionData('globalExitRootMap', [batch.batchNumber]);
            const globalExitRootResult = await zkEVMDB.vm.runCall({
                to: addressInstanceGlobalExitRoot,
                caller: Address.zero(),
                data: Buffer.from(encodedData.slice(2), 'hex'),
            });
            expect(globalExitRootResult.execResult.returnValue.toString('hex')).to.be.equal(globalExitRoot.slice(2));
        }

        // Check the circuit input
        const circuitInput = await batch.getStarkInput();

        // Check the encode transaction match with the vector test
        if (!update) {
            expect(batchL2Data).to.be.equal(batch.getBatchL2Data());
            // Check the batchHashData and the input hash
            expect(batchHashData).to.be.equal(circuitInput.batchHashData);
            expect(inputHash).to.be.equal(circuitInput.inputHash);
            expect(newLocalExitRoot).to.be.equal(circuitInput.newLocalExitRoot);
        } else {
            testE2E.batchL2Data = batch.getBatchL2Data();
            testE2E.batchHashData = circuitInput.batchHashData;
            testE2E.inputHash = circuitInput.inputHash;
            testE2E.newLocalExitRoot = circuitInput.newLocalExitRoot;
        }

        /*
         * /////////////////////////////////////////////////
         * // Check against the smart contracts
         * /////////////////////////////////////////////////
         */

        const currentStateRoot = `0x${Scalar.e(expectedOldRoot).toString(16).padStart(64, '0')}`;
        const currentLocalExitRoot = `0x${Scalar.e(oldLocalExitRoot).toString(16).padStart(64, '0')}`;
        const newStateRoot = `0x${Scalar.e(expectedNewRoot).toString(16).padStart(64, '0')}`;
        const currentGlobalExitRoot = `0x${Scalar.e(globalExitRoot).toString(16).padStart(64, '0')}`;

        // sequencer send the batch
        const lastBatchSent = await proofOfEfficiencyContract.lastBatchSent();
        const l2txData = batchL2Data;
        const maticAmount = await proofOfEfficiencyContract.calculateSequencerCollateral();

        await expect(
            maticTokenContract.connect(walletSequencer).approve(proofOfEfficiencyContract.address, maticAmount),
        ).to.emit(maticTokenContract, 'Approval');

        // set timestamp for the sendBatch call
        await setNextBlockTimestamp(timestamp);

        await expect(proofOfEfficiencyContract.connect(walletSequencer).sendBatch(l2txData, maticAmount))
            .to.emit(proofOfEfficiencyContract, 'SendBatch')
            .withArgs(lastBatchSent + 1, sequencerAddress, chainIdSequencer, currentGlobalExitRoot);

        // check batch sent
        const sentBatch = await proofOfEfficiencyContract.sentBatches(lastBatchSent + 1);
        expect(sentBatch.batchHashData).to.be.equal(circuitInput.batchHashData);

        // Check inputs mathces de smart contract
        const numBatch = (await proofOfEfficiencyContract.lastVerifiedBatch()) + 1;
        const proofA = ['0', '0'];
        const proofB = [
            ['0', '0'],
            ['0', '0'],
        ];
        const proofC = ['0', '0'];

        // calculate circuit input
        const circuitInputSC = await proofOfEfficiencyContract.calculateCircuitInput(
            currentStateRoot,
            currentLocalExitRoot,
            newStateRoot,
            newLocalExitRoot,
            circuitInput.batchHashData,
        );

        // Compute Js input
        const circuitInputJS = calculateSnarkInput(
            currentStateRoot,
            currentLocalExitRoot,
            newStateRoot,
            newLocalExitRoot,
            circuitInput.batchHashData,
        );
        const circuitInputSCHex = `0x${Scalar.e(circuitInputSC).toString(16).padStart(64, '0')}`;
        expect(circuitInputSCHex).to.be.equal(circuitInputJS);

        // mod inputHash stark
        const inputSnark = `0x${Scalar.mod(Scalar.fromString(inputHash, 16), Constants.FrSNARK).toString(16).padStart(64, '0')}`;
        expect(circuitInputSCHex).to.be.equal(inputSnark);

        // Check the input parameters are correct
        const circuitNextInputSC = await proofOfEfficiencyContract.getNextCircuitInput(
            newLocalExitRoot,
            newStateRoot,
            numBatch,
        );
        expect(circuitNextInputSC).to.be.equal(circuitInputSC);

        // Forge the batch
        const initialAggregatorMatic = await maticTokenContract.balanceOf(
            await aggregator.address,
        );

        await expect(
            proofOfEfficiencyContract.connect(aggregator).verifyBatch(
                newLocalExitRoot,
                newStateRoot,
                numBatch,
                proofA,
                proofB,
                proofC,
            ),
        ).to.emit(proofOfEfficiencyContract, 'VerifyBatch')
            .withArgs(numBatch, aggregator.address)
            .to.emit(globalExitRootManager, 'UpdateGlobalExitRoot')
            .withArgs(++lastGlobalExitRootNum, mainnetRoot, newLocalExitRoot);

        const finalAggregatorMatic = await maticTokenContract.balanceOf(
            await aggregator.address,
        );
        expect(finalAggregatorMatic).to.equal(
            ethers.BigNumber.from(initialAggregatorMatic).add(ethers.BigNumber.from(maticAmount)),
        );

        /*
        * /////////////////////////////////////////////////
        * //Claim funds from L2
        * /////////////////////////////////////////////////
        */

        // Add a claim leaf to rollup exit tree
        const originalNetworkClaim = networkIDMainnet;
        const tokenAddressClaim = ethers.constants.AddressZero; // ether
        const amountClaim = ethers.utils.parseEther('1');
        const destinationNetworkClaim = networkIDMainnet;
        const destinationAddressClaim = claimAddress;

        // pre compute root merkle tree in Js
        const height = 32;
        const merkleTree = new MerkleTreeBridge(height);
        const leafValue = calculateLeafValue(
            originalNetworkClaim,
            tokenAddressClaim,
            amountClaim,
            destinationNetworkClaim,
            destinationAddressClaim,
        );
        merkleTree.add(leafValue);
        const rollupExitRoot = merkleTree.getRoot();
        expect(newLocalExitRoot).to.be.equal(rollupExitRoot);

        const index = 0;
        const proof = merkleTree.getProofTreeByIndex(index);
        await expect(bridgeContract.claim(
            tokenAddressClaim,
            amountClaim,
            originalNetworkClaim,
            destinationNetworkClaim,
            destinationAddressClaim,
            proof,
            index,
            lastGlobalExitRootNum,
            mainnetRoot,
            rollupExitRoot,
        ))
            .to.emit(bridgeContract, 'ClaimEvent')
            .withArgs(
                index,
                originalNetworkClaim,
                tokenAddressClaim,
                amountClaim,
                destinationAddressClaim,
            );
    });

    after(async () => {
        if (update) {
            fs.writeFileSync(pathStateTransition, JSON.stringify(testE2E, null, 2));
        }
    });
});